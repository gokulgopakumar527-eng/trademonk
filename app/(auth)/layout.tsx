import { Wordmark } from "@/components/layout/wordmark";
import { Disclaimer } from "@/components/layout/disclaimer";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 py-10">
      <Wordmark />
      <main className="flex-1 py-12">{children}</main>
      <Disclaimer />
    </div>
  );
}
