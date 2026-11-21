import { Suppliers } from '@/components/suppliers';
export const metadata = { title: 'Supplier profile' };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Suppliers id={id} />;
}
