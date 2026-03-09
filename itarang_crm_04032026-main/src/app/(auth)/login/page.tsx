
import { login, signup } from './actions';
import { Mail, Lock, UserPlus, LogIn } from 'lucide-react';
import Image from 'next/image';

export default function LoginPage() {
    return (
        <div className="flex min-h-screen bg-white">
            {/* Left Side - Image & Slogan */}
            <div className="hidden lg:flex lg:w-1/2 relative bg-[#F0F8FF] items-center justify-center overflow-hidden">
                {/* Background Slogan */}
                <div className="absolute top-12 left-0 right-0 z-10 text-center px-8">
                    <h2 className="text-2xl font-bold text-[#002B49] leading-tight">
                        "Unleash Your Potential with the<br />
                        <span className="text-[#002B49]">Next-Gen E-Rickshaw Battery"</span>
                    </h2>
                </div>

                {/* Main Image */}
                <div className="relative w-full h-full flex items-end justify-center pb-0">
                    {/* 
                         NOTE: Please ensure 'rickshaw-login.png' is placed in the public/ folder.
                         Ideally, this image should be transparent PNG of the driver and rickshaw.
                     */}
                    <div className="relative w-[90%] h-[80%]">
                        <Image
                            src="/rickshaw-login.png"
                            alt="Rickshaw Driver and Battery"
                            fill
                            className="object-contain object-bottom"
                            priority
                        />
                    </div>
                </div>
            </div>

            {/* Right Side - Login Form */}
            <div className="w-full lg:w-1/2 flex flex-col justify-center px-8 sm:px-12 lg:px-24 xl:px-32 bg-white">
                <div className="w-full max-w-sm mx-auto">
                    {/* Brand Logo */}
                    <div className="mb-10">
                        <div className="flex items-center gap-3 mb-6">
                            {/* 
                                NOTE: Please ensure 'logo-full.png' is placed in the public/ folder.
                            */}
                            <Image
                                src="/logo-full.png"
                                alt="iTarang Logo"
                                width={180}
                                height={60}
                                className="h-12 w-auto object-contain"
                            />
                        </div>
                        <h1 className="text-3xl font-bold text-gray-900 mb-2">Welcome to iTarang</h1>
                        <p className="text-sm font-medium text-gray-500 uppercase tracking-wide">EVERY THING EV!</p>
                    </div>

                    <form className="space-y-6">
                        <div>
                            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2">
                                Email address
                            </label>
                            <div className="relative">
                                <input
                                    id="email"
                                    name="email"
                                    type="email"
                                    required
                                    className="w-full px-4 py-3 bg-white border border-gray-200 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                                    placeholder="name@company.com"
                                />
                                <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                                    <Mail className="h-5 w-5 text-gray-400" />
                                </div>
                            </div>
                        </div>

                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                                    Password
                                </label>
                                <a href="#" className="text-sm font-medium text-blue-600 hover:text-blue-500">
                                    Forgot password?
                                </a>
                            </div>
                            <div className="relative">
                                <input
                                    id="password"
                                    name="password"
                                    type="password"
                                    required
                                    className="w-full px-4 py-3 bg-white border border-gray-200 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                                    placeholder="••••••••"
                                />
                                <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                                    <Lock className="h-5 w-5 text-gray-400" />
                                </div>
                            </div>
                        </div>

                        <div className="pt-2">
                            <button
                                formAction={login}
                                className="w-full flex justify-center py-3 px-4 border border-transparent rounded-lg shadow-sm text-sm font-semibold text-white bg-[#005596] hover:bg-[#00447a] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                            >
                                <span className="mr-2">Sign In</span>
                            </button>
                        </div>

                        <div className="relative py-4">
                            <div className="absolute inset-0 flex items-center">
                                <div className="w-full border-t border-gray-200" />
                            </div>
                            <div className="relative flex justify-center text-sm">
                                <span className="px-2 bg-white text-gray-500">Don't have an account? <button formAction={signup} className="font-medium text-blue-600 hover:text-blue-500">Create one</button></span>
                            </div>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    )
}
