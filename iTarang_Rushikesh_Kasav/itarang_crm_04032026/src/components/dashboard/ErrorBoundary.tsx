'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertCircle, RefreshCcw } from 'lucide-react';

interface Props {
    children?: ReactNode;
    fallback?: ReactNode;
    title?: string;
}

interface State {
    hasError: boolean;
    error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false
    };

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('Uncaught error:', error, errorInfo);
    }

    private handleReset = () => {
        this.setState({ hasError: false, error: undefined });
        window.location.reload();
    };

    public render() {
        if (this.state.hasError) {
            return this.props.fallback || (
                <div className="flex flex-col items-center justify-center p-8 bg-rose-50 border border-rose-100 rounded-2xl text-center space-y-4">
                    <div className="w-12 h-12 bg-rose-100 rounded-full flex items-center justify-center">
                        <AlertCircle className="w-6 h-6 text-rose-600" />
                    </div>
                    <div className="space-y-1">
                        <h3 className="text-lg font-semibold text-rose-900">
                            {this.props.title || 'Panel Load Failed'}
                        </h3>
                        <p className="text-sm text-rose-700 max-w-xs mx-auto">
                            Something went wrong while loading this data. Please try refreshing or contact support.
                        </p>
                    </div>
                    <button
                        onClick={this.handleReset}
                        className="flex items-center gap-2 px-4 py-2 bg-rose-600 text-white rounded-lg text-sm font-medium hover:bg-rose-700 transition-colors shadow-sm"
                    >
                        <RefreshCcw className="w-4 h-4" />
                        Retry Load
                    </button>
                    {process.env.NODE_ENV === 'development' && (
                        <pre className="mt-4 p-4 bg-slate-900 text-slate-100 text-xs rounded-lg text-left overflow-auto max-w-full">
                            {this.state.error?.message}
                        </pre>
                    )}
                </div>
            );
        }

        return this.props.children;
    }
}
