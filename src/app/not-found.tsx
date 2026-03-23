import Link from 'next/link';
import { FileQuestion } from 'lucide-react';

export default function NotFound() {
    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 px-4 text-center">
            <div className="p-4 bg-white rounded-full shadow-sm mb-6">
                <FileQuestion className="w-12 h-12 text-gray-400" />
            </div>
            <h2 className="text-3xl font-bold text-gray-900 mb-2">Page Not Found</h2>
            <p className="text-gray-500 mb-8 max-w-md">
                We couldn't find the page you were looking for. It might have been moved, deleted, or you might have the wrong URL.
            </p>
            <Link
                href="/"
                className="inline-flex items-center justify-center px-5 py-2.5 border border-transparent text-sm font-medium rounded-lg text-white bg-brand-600 hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
            >
                Go back home
            </Link>
        </div>
    );
}
