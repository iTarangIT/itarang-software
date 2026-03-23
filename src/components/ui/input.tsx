import { InputHTMLAttributes, forwardRef } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    error?: boolean;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
    ({ className, error, ...props }, ref) => {
        return (
            <input
                ref={ref}
                className={`flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:cursor-not-allowed disabled:opacity-50 ${error ? 'border-red-500 focus:ring-red-500' : ''
                    } ${className || ''}`}
                {...props}
            />
        );
    }
);
Input.displayName = 'Input';

export { Input };
