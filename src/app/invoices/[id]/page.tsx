import { InvestigationWorkspace } from '@/components/investigation-workspace';
export const metadata = { title: 'Investigation workspace' };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvestigationWorkspace key={id} id={id} />;
}
