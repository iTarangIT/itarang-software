import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Download, Calendar, ArrowUpRight } from 'lucide-react';

const dataSales = [
  { name: 'Jan', revenue: 400000, orders: 24 },
  { name: 'Feb', revenue: 300000, orders: 13 },
  { name: 'Mar', revenue: 200000, orders: 98 },
  { name: 'Apr', revenue: 278000, orders: 39 },
  { name: 'May', revenue: 189000, orders: 48 },
  { name: 'Jun', revenue: 239000, orders: 38 },
];

const dataSources = [
  { name: 'Bolna AI', value: 400 },
  { name: 'Digital', value: 300 },
  { name: 'Referral', value: 300 },
  { name: 'Call Center', value: 200 },
];

const COLORS = ['#3F8C7F', '#8884d8', '#ffc658', '#ff8042'];

export const Reports: React.FC = () => {
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Analytics & Reports</h1>
          <p className="text-gray-500 text-sm mt-1">Deep dive into sales performance, AI efficiency, and operational metrics.</p>
        </div>
        <div className="flex gap-3">
             <button className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm font-medium hover:bg-gray-50">
                <Calendar className="w-4 h-4 text-gray-500" />
                <span>Last 30 Days</span>
             </button>
             <button className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-xl hover:bg-primary-700 text-sm font-medium shadow-lg shadow-primary-600/30">
                <Download className="w-4 h-4" />
                Export PDF
             </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Revenue Chart */}
          <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
             <div className="flex items-center justify-between mb-6">
                 <h3 className="text-lg font-bold text-gray-900">Revenue Trend</h3>
                 <span className="text-sm text-green-600 font-medium flex items-center gap-1">
                    <ArrowUpRight className="w-4 h-4" /> +12.5%
                 </span>
             </div>
             <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dataSales}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                        <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: '#9CA3AF', fontSize: 12}} dy={10} />
                        <YAxis axisLine={false} tickLine={false} tick={{fill: '#9CA3AF', fontSize: 12}} />
                        <Tooltip cursor={{fill: '#F3F5F7'}} contentStyle={{borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'}} />
                        <Bar dataKey="revenue" fill="#3F8C7F" radius={[4, 4, 0, 0]} barSize={40} />
                    </BarChart>
                </ResponsiveContainer>
             </div>
          </div>

          {/* Lead Source Distribution */}
          <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
             <div className="flex items-center justify-between mb-6">
                 <h3 className="text-lg font-bold text-gray-900">Lead Source Attribution</h3>
             </div>
             <div className="h-[300px] flex items-center justify-center">
                <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                        <Pie
                            data={dataSources}
                            cx="50%"
                            cy="50%"
                            innerRadius={60}
                            outerRadius={100}
                            fill="#8884d8"
                            paddingAngle={5}
                            dataKey="value"
                        >
                            {dataSources.map((entry, index) => (
                                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                            ))}
                        </Pie>
                        <Tooltip />
                    </PieChart>
                </ResponsiveContainer>
             </div>
             <div className="flex justify-center gap-6 mt-4">
                 {dataSources.map((entry, index) => (
                     <div key={index} className="flex items-center gap-2">
                         <div className="w-3 h-3 rounded-full" style={{backgroundColor: COLORS[index % COLORS.length]}}></div>
                         <span className="text-xs text-gray-600 font-medium">{entry.name}</span>
                     </div>
                 ))}
             </div>
          </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
           <div className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl p-6 text-white">
               <h4 className="text-indigo-100 text-sm font-medium mb-1">Total Conversions</h4>
               <div className="text-3xl font-bold">1,248</div>
               <div className="mt-4 text-indigo-100 text-xs">
                   Up 18% from last month. AI leads converting 2x faster.
               </div>
           </div>
           <div className="bg-white rounded-2xl p-6 border border-gray-100 shadow-sm">
               <h4 className="text-gray-500 text-sm font-medium mb-1">Avg. Call Duration</h4>
               <div className="text-3xl font-bold text-gray-900">03:42</div>
               <div className="mt-4 text-green-600 text-xs font-medium">
                   Optimal range for qualification
               </div>
           </div>
           <div className="bg-white rounded-2xl p-6 border border-gray-100 shadow-sm">
               <h4 className="text-gray-500 text-sm font-medium mb-1">AI Sentiment Score</h4>
               <div className="text-3xl font-bold text-gray-900">8.4<span className="text-lg text-gray-400">/10</span></div>
               <div className="mt-4 text-gray-400 text-xs">
                   Based on last 500 calls
               </div>
           </div>
      </div>
    </div>
  );
};