"use client"

export default function ReviewStep({form}:any){

return(

<div className="space-y-6">

<h2 className="text-lg font-semibold">

Review Application

</h2>

<div className="border p-6 rounded">

<p>Company: {form.companyName}</p>

<p>GST: {form.gstNumber}</p>

</div>

<button
className="bg-[#1F5C8F] text-white px-6 py-2 rounded"
>

Submit Application

</button>

</div>

)

}