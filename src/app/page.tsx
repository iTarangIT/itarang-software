import { redirect } from 'next/navigation';

export default function HomePage() {
  const headers = new Headers();
headers.set('Referrer-Policy', 'no-referrer');

redirect('/login', { headers });
}



