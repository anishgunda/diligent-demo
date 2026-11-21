# IdentityTwin AI

IdentityTwin AI is a Next.js invoice fraud investigation demo in the `diligent-demo` repository. The frontend runs without a backend or credentials.

## Run locally

Use Node.js 24 with npm. From the repository root:

```sh
npm ci
npm run dev
```

Open [http://localhost:3000/invoices](http://localhost:3000/invoices). The default API mode is `mock`. See [`.env.example`](.env.example) for live frontend configuration.

```sh
npx tsc --noEmit
npm run lint
npm run build
npm run start
```

## Demo walkthrough

1. Open **Invoices → Upload Invoice → Use Sample Invoice**. Preview the PDF and select **Extract Details**.
2. Review the Westmere Logistics invoice and its payment destination mismatch. Select **Save to Queue**, open the saved invoice, and select **Run Investigation**.
3. Follow the streamed evidence until the verdict is **Hold for verification**. Refreshing or reopening the case resumes the simulated investigation from its last saved event.
4. Switch to **Finance Controller**. Record a verification method, outcome and notes. An inconclusive result keeps the hold. A confirmed legitimate change clears the fraud hold. Confirmed fraud rejects the payment request.
5. Open **View Audit Report** and **Export JSON**. The report records that payment authorisation is outside this workflow.
6. Use **Reset Demo Data** to restore the original fixtures and persona.

Use fictional data. An uploaded PDF remains in memory for native preview and is released when you leave intake. Mock extraction fills the bundled sample only. For other PDFs the review form is manual. The demo stores masked synthetic payment destinations and case data in browser local storage. Raw email bodies and PDFs are excluded. Browser storage holds the demo workflow for that browser.

## Deploy on Vercel

1. Commit the app in `diligent-demo` and push to the Git provider connected to Vercel.
2. In Vercel, import the repository and choose **Next.js** with the repository root as the project directory.
3. Use Node.js **24.x**. Leave the default build settings and optionally set `NEXT_PUBLIC_API_MODE=mock` for Preview and Production.
4. Deploy and open `/invoices`.

The mock deployment needs no backend URL, Clerk credentials, xAI key or database credentials. Follow the [Vercel Git deployment guide](https://vercel.com/docs/git) and [Node.js runtime settings](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).

## Integration

- [Backend setup, credentials and deployment](backend/README.md)

- [FastAPI contract](docs/api-contract.md)
- [LangGraph and policy architecture](docs/agent-architecture.md)
- [Phase 2 integration plan](docs/phase-2-plan.md)
