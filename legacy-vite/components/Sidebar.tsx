import React from 'react';
import { LayoutDashboard, ShoppingCart, Users, FileText, LogOut, Phone, PieChart, Package, FileCheck } from 'lucide-react';
import { useAuth } from './auth/AuthProvider';

interface SidebarProps {
  activePage: string;
  onNavigate: (page: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ activePage, onNavigate }) => {
  const { user, signOut } = useAuth();

  const handleLogout = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  // Filter menu items based on user role
  const getMenuItems = () => {
    const isDealerOnly = user?.roles.includes('dealer') && user.roles.length === 1;

    if (isDealerOnly) {
      // Dealers only see Dashboard and Orders
      return [
        { section: 'OVERVIEW', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard }] },
        {
          section: 'ORDERS', items: [
            { id: 'orders', label: 'My Orders', icon: Package },
          ]
        },
      ];
    }

    // Full menu for other roles
    return [
      { section: 'OVERVIEW', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard }] },
      {
        section: 'PROCUREMENT', items: [
          { id: 'provisions', label: 'Provisions', icon: ShoppingCart },
          { id: 'orders', label: 'Orders', icon: Package },
          { id: 'invoices', label: 'Invoices', icon: FileText },
        ]
      },
      {
        section: 'DEALER', items: [
          { id: 'leads', label: 'Leads', icon: Users },
          { id: 'calls', label: 'Calls (AI)', icon: Phone },
          { id: 'conversions', label: 'Conversions', icon: FileCheck },
        ]
      },
      {
        section: 'ANALYTICS', items: [
          { id: 'reports', label: 'Reports', icon: PieChart },
        ]
      }
    ];
  };

  const getRoleDisplayName = (roles: string[]) => {
    if (roles.includes('sales_head')) return 'Sales Head';
    if (roles.includes('ceo')) return 'CEO';
    if (roles.includes('sales_manager')) return 'Sales Manager';
    if (roles.includes('dealer')) return 'Dealer';
    return 'User';
  };

  const getRoleBadgeColor = (roles: string[]) => {
    if (roles.includes('ceo')) return 'bg-purple-100 text-purple-700';
    if (roles.includes('sales_head')) return 'bg-blue-100 text-blue-700';
    if (roles.includes('sales_manager')) return 'bg-green-100 text-green-700';
    if (roles.includes('dealer')) return 'bg-amber-100 text-amber-700';
    return 'bg-gray-100 text-gray-700';
  };

  const menuItems = getMenuItems();

  return (
    <div className="w-64 bg-slate-50/50 h-full border-r border-gray-100 flex flex-col fixed left-0 top-0 z-10 hidden md:flex">
      <div className="p-6 flex items-center gap-3">
        <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center">
          <div className="w-4 h-4 bg-white rounded-sm opacity-50 rotate-45"></div>
        </div>
        <span className="text-xl font-bold text-gray-800 tracking-tight">iTarang</span>
      </div>

      <div className="flex-1 overflow-y-auto py-4 px-4 space-y-8">
        {menuItems.map((group) => (
          <div key={group.section}>
            <h3 className="text-xs font-semibold text-gray-400 mb-3 px-2 tracking-wider">{group.section}</h3>
            <div className="space-y-1">
              {group.items.map((item) => {
                const isActive = activePage === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => onNavigate(item.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 relative group
                      ${isActive
                        ? 'bg-white text-primary-700 shadow-sm'
                        : 'text-gray-500 hover:bg-gray-100/50 hover:text-gray-900'
                      }`}
                  >
                    {isActive && (
                      <div className="absolute left-0 top-1.5 bottom-1.5 w-[3px] bg-primary-600 rounded-r-full" />
                    )}
                    <item.icon className={`w-5 h-5 ${isActive ? 'text-primary-600' : 'text-gray-400 group-hover:text-gray-600'}`} />
                    {item.label}
                    {item.id === 'calls' && (
                      <span className="ml-auto w-5 h-5 bg-orange-500 text-white text-[10px] rounded-full flex items-center justify-center font-bold">2</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* User Profile Section */}
      <div className="p-4 border-t border-gray-100/50 space-y-2">
        <div className="flex items-center gap-3 p-3 rounded-xl hover:bg-white hover:shadow-sm transition-all group cursor-default">
          <div className="w-9 h-9 bg-primary-600 rounded-full flex items-center justify-center text-white font-semibold text-sm shadow-sm group-hover:scale-105 transition-transform">
            {user?.full_name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">{user?.full_name}</p>
            <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium mt-1 ${getRoleBadgeColor(user?.roles || [])}`}>
              {getRoleDisplayName(user?.roles || [])}
            </span>
          </div>
        </div>

        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-500 hover:text-red-600 hover:bg-red-50 transition-all duration-200 group"
        >
          <LogOut className="w-5 h-5 transition-colors group-hover:text-red-600" />
          Logout
        </button>
      </div>
    </div>
  );
};