"use client"

export default function UploadCard({
title,
onUpload
}:{
title:string
onUpload:(file:File)=>void
}){

return(

<div className="border border-[#E3E8EF] rounded-lg p-6 bg-white">

<p className="font-medium mb-3">{title}</p>

<input
type="file"
onChange={(e)=>{
if(e.target.files){
onUpload(e.target.files[0])
}
}}
className="border p-2 rounded w-full"
/>

</div>

)

}