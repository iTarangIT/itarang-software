import React, { useState } from 'react';
import { AuthProvider, useAuth } from './components/auth/AuthProvider';
import { LoginPage } from './components/auth/LoginPage';
import { Layout } from './components/Layout';
import { Dashboard } from './components/Dashboard';
import { Provisions } from './components/Provisions';
import { Leads } from './components/Leads';
import { Orders } from './components/Orders';
import { Invoices } from './components/Invoices';
import { Calls } from './components/Calls';
import { Conversions } from './components/Conversions';
import { Reports } from './components/Reports';
import { ToastProvider } from './components/Toast';
import { SalesHeadDashboard } from './components/dashboards/SalesHeadDashboard';
import { CEODashboard } from './components/dashboards/CEODashboard';
import { SalesManagerDashboard } from './components/dashboards/SalesManagerDashboard';
import { DealerDashboard } from './components/dashboards/DealerDashboard';
import { Loader2 } from 'lucide-react';

const AppContent: React.FC = () => {
  const { user, loading } = useAuth();
  const [activePage, setActivePage] = useState('dashboard');

  // Show loading state while checking authentication
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-primary-600 mx-auto mb-4" />
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  // Show login page if not authenticated
  if (!user) {
    return <LoginPage />;
  }

  // Determine which dashboard to show based on user role
  const getRoleDashboard = () => {
    if (user.roles.includes('sales_head')) {
      return <SalesHeadDashboard />;
    } else if (user.roles.includes('ceo')) {
      return <CEODashboard />;
    } else if (user.roles.includes('sales_manager')) {
      return <SalesManagerDashboard />;
    } else if (user.roles.includes('dealer')) {
      return <DealerDashboard />;
    }
    return <Dashboard />;
  };

  const renderContent = () => {
    switch (activePage) {
      case 'dashboard':
        return getRoleDashboard();
      case 'provisions':
        // Dealers shouldn't see provisions
        if (user.roles.includes('dealer')) {
          return <div className="text-center py-12 text-gray-500">Access Denied</div>;
        }
        return <Provisions />;
      case 'orders':
        return <Orders />;
      case 'invoices':
        // Dealers shouldn't see invoices
        if (user.roles.includes('dealer')) {
          return <div className="text-center py-12 text-gray-500">Access Denied</div>;
        }
        return <Invoices />;
      case 'leads':
        // Dealers shouldn't see leads
        if (user.roles.includes('dealer')) {
          return <div className="text-center py-12 text-gray-500">Access Denied</div>;
        }
        return <Leads />;
      case 'calls':
        // Dealers shouldn't see calls
        if (user.roles.includes('dealer')) {
          return <div className="text-center py-12 text-gray-500">Access Denied</div>;
        }
        return <Calls />;
      case 'conversions':
        // Dealers shouldn't see conversions
        if (user.roles.includes('dealer')) {
          return <div className="text-center py-12 text-gray-500">Access Denied</div>;
        }
        return <Conversions />;
      case 'reports':
        return <Reports />;
      default:
        return (
          <div className="flex flex-col items-center justify-center h-[60vh] text-center animate-fade-in">
            <h2 className="text-2xl font-bold text-gray-300">Work in Progress</h2>
            <p className="text-gray-400 mt-2">This module ({activePage}) is currently under development.</p>
          </div>
        );
    }
  };

  return (
    <Layout activePage={activePage} onNavigate={setActivePage}>
      {renderContent()}
    </Layout>
  );
};

const App: React.FC = () => {
  return (
    <ToastProvider>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ToastProvider>
  );
};

export default App;