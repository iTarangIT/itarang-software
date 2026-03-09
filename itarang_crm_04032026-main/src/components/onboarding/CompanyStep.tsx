"use client"

export default function CompanyStep({form,setForm}:any){

return(

<div className="space-y-6">

<h2 className="text-lg font-semibold">Business Details</h2>

<input
placeholder="Company Name"
className="border p-3 rounded w-full"
value={form.companyName}
onChange={(e)=>setForm({...form,companyName:e.target.value})}
/>

<select
className="border p-3 rounded w-full"
value={form.companyType}
onChange={(e)=>setForm({...form,companyType:e.target.value})}
>

<option>Sole Proprietorship</option>
<option>Partnership Firm</option>
<option>Private Limited Firm</option>

</select>

<input
placeholder="GST Number"
className="border p-3 rounded w-full"
value={form.gstNumber}
onChange={(e)=>setForm({...form,gstNumber:e.target.value})}
/>

</div>

)

}