(() => {
"use strict";
const $=s=>document.querySelector(s),esc=v=>String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"})[c]);
$("#send").onclick=async()=>{
  const b=$("#send");b.disabled=true;$("#word").textContent="…";$("#meta").textContent="";$("#bars").innerHTML="";$("#raw").textContent="呼び出し中";
  try{
    const r=await fetch("/api/ask",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({inquiry:$("#inquiry").value})});
    const d=await r.json();if(!r.ok)throw Error(d.error||`HTTP ${r.status}`);
    const a=d.response.answers.route;
    $("#word").textContent=a.choice;
    $("#meta").textContent=`確信度 ${Number(a.confidence).toFixed(2)} ・ ${d.elapsed_ms} ms ・ ${d.response.model}`;
    // CSP が style 属性を禁じるので、棒の長さは CSSOM で入れる
    for(const [k,v] of Object.entries(a.probabilities).sort((x,y)=>y[1]-x[1])){const li=document.createElement("li");li.innerHTML=`<span>${esc(k)}</span><i></i><b>${Number(v).toFixed(2)}</b>`;li.querySelector("i").style.setProperty("--p",`${Math.round(v*100)}%`);$("#bars").append(li);}
    $("#raw").textContent=JSON.stringify(d.response,null,2);
  }catch(e){$("#word").textContent="エラー";$("#raw").textContent=e.message;}
  b.disabled=false;
};
})();
