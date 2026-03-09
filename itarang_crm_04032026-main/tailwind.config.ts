
import type { Config } from "tailwindcss";

const config: Config = {
    content: [
        "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    theme: {
        extend: {
            colors: {
                brand: {
                    50: '#F0FDFA', // Light Teal/Emerald background
                    100: '#CCFBF1',
                    500: '#14B8A6', // Primary Brand (Teal)
                    600: '#0D9488', // Hover Brand
                    700: '#0F766E', // Active Brand
                },
                surface: {
                    peach: '#FFF7ED', // Orange-50 equivalent
                    purple: '#FAF5FF', // Purple-50
                    teal: '#F0FDFA', // Teal-50
                    gray: '#F9FAFB', // Gray-50
                }
            },
            borderRadius: {
                'xl': '1rem',
                '2xl': '1.25rem',
                '3xl': '1.5rem',
            },
            boxShadow: {
                'soft': '0 4px 20px -2px rgba(0, 0, 0, 0.05)',
                'card': '0 1px 3px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.1)',
            }
        },
    },
    plugins: [],
};
export default config;
