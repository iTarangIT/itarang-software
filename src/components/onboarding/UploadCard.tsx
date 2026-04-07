'use client'

import { UploadCloud } from "lucide-react"

export default function UploadCard({ label }: any) {

  return (

    <div>

      <label className="text-sm font-medium text-gray-700 mb-2 block">
        {label}
      </label>

      <div className="border-2 border-dashed border-[#E3E8EF] bg-[#F9FBFD] p-6 rounded-xl text-center cursor-pointer hover:bg-gray-50">

        <UploadCloud className="mx-auto mb-2 text-gray-500"/>

        <p className="text-sm text-gray-500">
          Drag file or click to upload
        </p>

      </div>

    </div>

  )
}