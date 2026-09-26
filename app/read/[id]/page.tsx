import Reader from "@/components/Reader";

export default async function ReadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Reader key={id} bookId={id} />;
}
