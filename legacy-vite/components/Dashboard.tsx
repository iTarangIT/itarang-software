import React, { useState, useEffect } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { DASHBOARD_STATS } from '../constants';
import { ArrowUpRight, ArrowDownRight, MoreHorizontal, Calendar, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

const chartData = [
  { name: 'Mon', value: 4000 },
  { name: 'Tue', value: 3000 },
  { name: 'Wed', value: 2000 },
  { name: 'Thu', value: 2780 },
  { name: 'Fri', value: 1890 },
  { name: 'Sat', value: 2390 },
  { name: 'Sun', value: 3490 },
];

export const Dashboard: React.FC = () => {
  const [stats, setStats] = useState(DASHBOARD_STATS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      setLoading(true);

      // Fetch counts from Supabase
      const [
        { count: provisionsCount },
        { count: leadsCount },
        { count: ordersCount }
      ] = await Promise.all([
        supabase.from('provisions').select('*', { count: 'exact', head: true }),
        supabase.from('leads').select('*', { count: 'exact', head: true }),
        supabase.from('orders').select('*', { count: 'exact', head: true })
      ]);

      setStats(prev => prev.map(s => {
        if (s.label === 'Total Provisions') return { ...s, value: provisionsCount?.toString() || '0' };
        if (s.label === 'Active Leads') return { ...s, value: leadsCount?.toString() || '0' };
        if (s.label === 'Inventory Orders') return { ...s, value: ordersCount?.toString() || '0' };
        return s;
      }));

    } catch (error) {
      console.error('Error fetching dashboard stats:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Hi, Orely Studio 👋</h1>
          <p className="text-gray-500 text-sm mt-1">Here's what's happening with your procurement today.</p>
        </div>
        <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-lg border border-gray-200 shadow-sm text-sm text-gray-600">
          <Calendar className="w-4 h-4" />
          <span>23 May 23 - 28 May 23</span>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {stats.map((stat, idx) => {
          const bgColors: any = { pink: 'bg-pink-50', purple: 'bg-purple-50', primary: 'bg-teal-50' };
          const textColors: any = { pink: 'text-pink-600', purple: 'text-purple-600', primary: 'text-teal-600' };

          return (
            <div key={idx} className={`${bgColors[stat.color || 'primary']} p-6 rounded-2xl flex items-start justify-between relative overflow-hidden transition-transform hover:scale-[1.01] duration-300`}>
              <div className="relative z-10">
                <div className="flex items-center gap-3 mb-4">
                  <div className="p-2 bg-white rounded-lg shadow-sm">
                    {stat.icon}
                  </div>
                  <span className="text-gray-600 font-medium text-sm">{stat.label}</span>
                </div>
                <div className="flex items-baseline gap-2">
                  {loading ? (
                    <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                  ) : (
                    <h3 className="text-3xl font-bold text-gray-900">{stat.value}</h3>
                  )}
                  <div className={`flex items-center text-xs font-semibold ${textColors[stat.color || 'primary']}`}>
                    {stat.trend === 'up' ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                    {stat.trendValue}
                  </div>
                </div>
                <p className="text-gray-500 text-xs mt-2">{stat.subValue}</p>
              </div>
              <div className="absolute -right-4 -bottom-4 w-24 h-24 bg-white opacity-30 rounded-full blur-xl pointer-events-none"></div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-lg font-bold text-gray-900">Procurement & Sales Timeline</h3>
              <div className="flex items-center gap-2 mt-1">
                <span className="inline-block w-2 h-2 rounded-full bg-green-400"></span>
                <p className="text-xs text-green-600 font-medium">Updated 5 min ago</p>
              </div>
            </div>
            <button className="p-2 hover:bg-gray-50 rounded-lg text-gray-400">
              <MoreHorizontal className="w-5 h-5" />
            </button>
          </div>

          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3F8C7F" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#3F8C7F" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#9CA3AF', fontSize: 12 }} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: '#9CA3AF', fontSize: 12 }} />
                <Tooltip
                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  cursor={{ stroke: '#3F8C7F', strokeWidth: 1, strokeDasharray: '5 5' }}
                />
                <Area type="monotone" dataKey="value" stroke="#3F8C7F" strokeWidth={3} fillOpacity={1} fill="url(#colorValue)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm flex flex-col items-center text-center justify-center relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-pink-500 to-purple-500"></div>
          <h3 className="text-lg font-bold text-gray-900 mb-2">Delivery Goals</h3>
          <div className="flex items-end justify-center gap-1 mb-6">
            <span className="text-3xl font-bold text-gray-900">603</span>
            <span className="text-sm text-gray-400 mb-1">vs 966 last period</span>
          </div>

          <div className="relative w-40 h-40 flex items-center justify-center mb-6">
            <div className="w-full h-full rounded-full border-[12px] border-primary-100 border-t-primary-500 rotate-45 transform transition-all duration-1000 ease-out"></div>
            <div className="absolute inset-0 flex items-center justify-center flex-col">
              <span className="text-2xl font-bold text-primary-600">60%</span>
            </div>
          </div>

          <p className="text-sm text-gray-500">Deliver 1,000 package to reach your 100% target</p>
        </div>
      </div>
    </div>
  );
};