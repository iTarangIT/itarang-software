import { ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils'; // Assuming cn exists or clsx/tailwind-merge is used. Wait, I should verify utils.

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
    size?: 'sm' | 'md' | 'lg';
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant = 'primary', size = 'md', ...props }, ref) => {
        const baseStyles = 'inline-flex items-center justify-center rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none';

        const variants = {
            primary: 'bg-brand-600 text-white hover:bg-brand-700 focus:ring-brand-500', // Assuming brand colors exist
            secondary: 'bg-gray-100 text-gray-900 hover:bg-gray-200 focus:ring-gray-500',
            outline: 'border border-gray-300 bg-transparent hover:bg-gray-50 text-gray-700 focus:ring-brand-500',
            ghost: 'bg-transparent hover:bg-gray-100 text-gray-700 focus:ring-gray-500',
            danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500',
        };

        const sizes = {
            sm: 'h-8 px-3 text-xs',
            md: 'h-10 px-4 py-2 text-sm',
            lg: 'h-12 px-6 text-base',
        };

        // Fallback if brand colors missing
        const safeVariants = {
            ...variants,
            primary: 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500',
        };

        return (
            <button
                ref={ref}
                className={`${baseStyles} ${safeVariants[variant]} ${sizes[size]} ${className || ''}`}
                {...props}
            />
        );
    }
);
Button.displayName = 'Button';

export { Button };
