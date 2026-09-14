import { CroLoginForm } from './CroLoginForm';

export const dynamic = 'force-dynamic';

export default function CroLoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center p-6">
      <CroLoginForm />
    </main>
  );
}
