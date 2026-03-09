export interface ApiResponse<T> {
    success: boolean;
    data?: T;
    error?: {
        message: string;
        code?: string;
        details?: any;
    };
    timestamp: string;
}

export type DashboardRole =
    | 'ceo'
    | 'business_head'
    | 'sales_head'
    | 'sales_manager'
    | 'finance_controller'
    | 'inventory_manager'
    | 'service_engineer'
    | 'sales_order_manager'
    | 'dealer';

export interface DashboardMetrics {
    revenue: number;
    revenueGrowth: number;
    conversionRate: number;
    conversionGrowth: number;
    inventoryValue: number;
    outstandingCredits: number;
    overdueCredits: number;
    salesTrend: Array<{ date: string; revenue: number }>;
}
