export function LegalDoc({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="space-y-4 leading-relaxed [&_h2]:mt-8 [&_h2]:font-medium [&_p]:text-muted">
      <h1 className="font-display text-3xl font-medium">{title}</h1>
      <p
        role="note"
        className="rounded-[4px] border border-saffron/50 px-3 py-2 text-sm !text-saffron"
      >
        Placeholder text. This document has not been reviewed by a qualified lawyer and must be
        replaced before launch.
      </p>
      {children}
    </article>
  );
}
