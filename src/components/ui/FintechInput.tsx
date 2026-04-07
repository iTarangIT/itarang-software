'use client'

import { useState } from "react"

export default function FintechInput({
  label,
  type="text"
}: any) {

  const [value,setValue] = useState("")

  return(

    <div className="relative w-full">

      <input
        type={type}
        value={value}
        onChange={(e)=>setValue(e.target.value)}
        placeholder=" "
        className="peer w-full px-4 pt-6 pb-2 border border-[#E3E8EF] rounded-lg bg-white focus:border-[#1F5C8F] focus:ring-2 focus:ring-blue-100 outline-none transition"
      />

      <label
        className="absolute left-4 top-2 text-xs text-gray-500 transition-all
        peer-placeholder-shown:top-4
        peer-placeholder-shown:text-sm
        peer-focus:top-2
        peer-focus:text-xs"
      >
        {label}
      </label>

    </div>

  )
}