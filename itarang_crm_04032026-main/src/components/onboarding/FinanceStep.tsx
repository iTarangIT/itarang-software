"use client"

export default function FinanceStep({form,setForm}:any){

return(

<div className="space-y-6">

<h2 className="text-lg font-semibold">

Finance Enablement

</h2>

<div className="flex gap-4">

<button
className={`border p-4 rounded ${
form.financeEnabled?"bg-[#1F5C8F] text-white":""
}`}
onClick={()=>setForm({...form,financeEnabled:true})}
>

Enable Finance

</button>

<button
className={`border p-4 rounded ${
!form.financeEnabled?"bg-[#1F5C8F] text-white":""
}`}
onClick={()=>setForm({...form,financeEnabled:false})}
>

No Finance

</button>

</div>

</div>

)

}