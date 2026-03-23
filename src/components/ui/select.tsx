import { SelectHTMLAttributes, forwardRef } from 'react';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
    error?: boolean;
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
    ({ className, children, error, ...props }, ref) => {
        return (
            <select
                ref={ref}
                className={`flex h-10 w-full items-center justify-between rounded-md border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:cursor-not-allowed disabled:opacity-50 ${error ? 'border-red-500 focus:ring-red-500' : ''
                    } ${className || ''}`}
                {...props}
            >
                {children}
            </select>
        );
    }
);
Select.displayName = 'Select';

export { Select };
