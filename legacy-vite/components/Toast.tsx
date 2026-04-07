import React, { useState, useEffect, createContext, useContext } from 'react';
import { CheckCircle, AlertCircle, X, Info } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info';

interface Toast {
    id: string;
    message: string;
    type: ToastType;
}

interface ToastContextType {
    showToast: (message: string, type: ToastType) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
    const context = useContext(ToastContext);
    if (!context) throw new Error('useToast must be used within a ToastProvider');
    return context;
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const showToast = (message: string, type: ToastType) => {
        const id = Math.random().toString(36).substring(2, 9);
        setToasts((prev) => [...prev, { id, message, type }]);
        setTimeout(() => {
            removeToast(id);
        }, 5000);
    };

    const removeToast = (id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    };

    return (
        <ToastContext.Provider value={{ showToast }}>
            {children}
            <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-3 pointer-events-none">
                {toasts.map((toast) => (
                    <ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
                ))}
            </div>
        </ToastContext.Provider>
    );
};

const ToastItem: React.FC<{ toast: Toast; onClose: () => void }> = ({ toast, onClose }) => {
    const icons = {
        success: <CheckCircle className="w-5 h-5 text-green-500" />,
        error: <AlertCircle className="w-5 h-5 text-red-500" />,
        info: <Info className="w-5 h-5 text-blue-500" />
    };

    const bgStyles = {
        success: 'bg-green-50 border-green-100',
        error: 'bg-red-50 border-red-100',
        info: 'bg-blue-50 border-blue-100'
    };

    return (
        <div className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl border shadow-xl animate-in slide-in-from-right-10 fade-in duration-300 ${bgStyles[toast.type]}`}>
            <div className="shrink-0">{icons[toast.type]}</div>
            <p className="text-sm font-medium text-gray-800 mr-2">{toast.message}</p>
            <button
                onClick={onClose}
                className="shrink-0 p-1 hover:bg-black/5 rounded-lg transition-colors text-gray-400"
            >
                <X className="w-4 h-4" />
            </button>
        </div>
    );
};
