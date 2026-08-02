"use client";

/** Shared chrome for the three placeholder tabs. Delete with them. */

export function TabHeader({
  kicker,
  title,
  body,
}: {
  kicker: string;
  title: string;
  body: string;
}) {
  return (
    <header>
      <div className="mono-up" style={{ opacity: 0.55 }}>{kicker}</div>
      <h1
        className="display"
        style={{
          margin: "var(--space-2) 0 0",
          fontSize: "var(--text-2xl)",
          lineHeight: 1.15,
          fontWeight: 600,
          color: "var(--ink)",
        }}
      >
        {title}
      </h1>
      <p className="body-sans" style={{ margin: "var(--space-3) 0 0", maxWidth: 480 }}>
        {body}
      </p>
    </header>
  );
}

export function PlaceholderSection({ label }: { label: string }) {
  return (
    <section className="placeholder-block">
      <div className="mono-up" style={{ opacity: 0.5, marginBottom: "var(--space-3)" }}>
        {label}
      </div>
      {/* Grey bars instead of lorem ipsum: unmistakably unfinished, and they
          cannot be mistaken for a real product claim. */}
      <div style={{ display: "grid", gap: "var(--space-2)" }} aria-hidden="true">
        {["100%", "82%", "64%"].map((width) => (
          <div
            key={width}
            style={{
              width,
              height: 8,
              borderRadius: 4,
              background: "var(--hairline)",
            }}
          />
        ))}
      </div>
    </section>
  );
}
