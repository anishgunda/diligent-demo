import { Reports } from '@/components/reports';
export const metadata = { title: 'Audit report' };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Reports id={id} />;
}
