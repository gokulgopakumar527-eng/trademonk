export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-8 max-w-2xl">
      <h1 className="font-display text-3xl font-medium">{title}</h1>
      {description ? <p className="mt-2 text-muted">{description}</p> : null}
    </header>
  );
}
