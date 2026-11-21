import asyncio
import json
import re
import subprocess
import sys
from datetime import datetime
from io import BytesIO

from pypdf import PdfReader

MAX_PAGES = 20
MAX_TEXT = 40000


def first(text: str, pattern: str, default=""):
    match = re.search(pattern, text, flags=re.I | re.M)
    return match.group(1).strip() if match else default


def parse_date(raw):
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d %B %Y", "%d %b %Y"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    return ""


def parse_invoice(text: str):
    amount = first(
        text,
        r"^(?:total\s*(?:due|payable|incl\.?\s*vat)|amount\s*due|grand\s*total)\s*:?\s*(?:GBP|£)?\s*([\d,]+\.\d{2})\s*$",
    )
    invoice_date = first(text, r"^(?:invoice\s*date|date\s*issued|issued)\s*:?\s*([^\r\n]{1,35})")
    due_date = first(text, r"^(?:due\s*date|payment\s*due\s*date|due)\s*:?\s*([^\r\n]{1,35})")
    return {
        "supplierName": first(text, r"^(?:supplier|seller|vendor|from)\s*:\s*([^\r\n]{2,100})"),
        "companyNumber": first(
            text,
            r"^(?:companies house(?: number)?|company (?:registration )?(?:number|no\.?))\s*:?\s*([A-Z0-9]{8})\b",
        ).upper(),
        "invoiceNumber": first(
            text, r"^invoice\s*(?:number|no\.?|#|:)\s*:?\s*([A-Z0-9][A-Z0-9._/-]{0,47})\s*$"
        ),
        "amount": float(amount.replace(",", "")) if amount else None,
        "invoiceDate": parse_date(invoice_date),
        "dueDate": parse_date(due_date),
        "senderEmail": first(text, r"^(?:sender|email|e-mail)\s*:\s*([\w.+-]+@[A-Z0-9.-]+\.[A-Z]{2,63})\s*$")[
            :160
        ],
        "signer": first(text, r"^(?:signer|signed by|authorised by)\s*:\s*([^\r\n]{1,80})"),
        "paymentReference": first(text, r"^(?:payment|remittance) reference\s*:\s*([^\r\n]{1,48})"),
        "sortCode": first(text, r"^sort code\s*:\s*(\d{2}(?:[- ]?\d{2}){2})\s*$"),
        "account": first(text, r"^(?:bank )?account(?: number| no\.?)?\s*:\s*(\d{4} ?\d{4})\s*$"),
    }


def process(data: bytes):
    try:
        pdf = PdfReader(BytesIO(data))
        if pdf.is_encrypted:
            return {"error": "Password-protected PDFs are unsupported."}
        if not 0 < len(pdf.pages) <= MAX_PAGES:
            return {"error": "The invoice must contain between 1 and 20 pages."}
        text = ""
        for page in pdf.pages:
            text += (page.extract_text() or "")[: MAX_TEXT - len(text)] + "\n"
            if len(text) >= MAX_TEXT:
                break
        if len(re.sub(r"\W", "", text)) < 6:
            return {"error": "This PDF needs OCR. Upload a text-based invoice."}
        return {"draft": parse_invoice(text)}
    except Exception:
        return {"error": "The PDF could not be parsed safely."}


def _extract(data: bytes):
    try:
        process = subprocess.run(
            [sys.executable, "-m", "app.services.extraction"],
            input=data,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=8,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"error": "The PDF exceeded the safe extraction time limit."}
    if process.returncode or len(process.stdout) > 12000:
        return {"error": "The PDF exceeded extraction limits or could not be parsed."}
    return json.loads(process.stdout)


async def extract_in_worker(data: bytes):
    worker = asyncio.create_task(asyncio.to_thread(_extract, data))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        await worker
        raise


if __name__ == "__main__":
    if sys.platform.startswith("linux"):
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (384 * 1024**2, 384 * 1024**2))
        resource.setrlimit(resource.RLIMIT_CPU, (7, 8))
    raw = sys.stdin.buffer.read(15 * 1024**2 + 1)
    if len(raw) > 15 * 1024**2:
        print(json.dumps({"error": "The PDF exceeds 15 MB."}))
    else:
        print(json.dumps(process(raw)))
