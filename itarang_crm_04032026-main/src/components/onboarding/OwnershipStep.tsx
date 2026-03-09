"use client"

export default function OwnershipStep({form,setForm}:any){

if(form.companyType==="Sole Proprietorship"){

return(

<div className="space-y-4">

<input
placeholder="Owner Name"
className="border p-3 rounded w-full"
/>

<input
placeholder="Owner Email"
className="border p-3 rounded w-full"
/>

</div>

)

}

if(form.companyType==="Partnership Firm"){

return(

<div>

<h3 className="font-medium mb-4">
Partners
</h3>

<button
className="bg-[#1F5C8F] text-white px-4 py-2 rounded"
>

+ Add Partner

</button>

</div>

)

}

return(

<div>

<h3 className="font-medium">
Directors
</h3>

</div>

)

}