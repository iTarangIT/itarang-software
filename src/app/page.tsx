import { redirect } from 'next/navigation';

export default function HomePage() {
  // Referrer-Policy is set globally in next.config.ts headers() — redirect()
  // takes a RedirectType as its 2nd arg, not a response-header bag.
  redirect('/login');
}




