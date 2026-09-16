// The browser half of the human transfer fallback (t_dad9f0e09ffb). Served
// inline by the files-domain CloudFront Function at https://<filesDomain>/_transfer
// — the SAME origin as the presigned file URLs, so the upload POST and the
// download link never leave the first-party host, and no Lambda ever sees a byte.
//
// The link's FRAGMENT carries everything (base64url JSON, written by the
// connector's src/storage/transfer-link.ts — keep the two in step):
//   upload   {v:1, op:"upload", path, exp, max, type, overwrite, fields}
//   download {v:1, op:"download", path, exp, url}
// A fragment never reaches a server, so opening or previewing the link neither
// logs the signature nor consumes anything; the upload only starts on a click.
//
// Every value is shown with textContent, and the download target must be a
// same-origin path: a crafted fragment must not turn a first-party page into a
// link to someone else's site.

export const PAGE_SCRIPT = `(function(){
var fr=!/^en/i.test(navigator.language||"");
var T=fr?{bad:"Lien invalide ou incomplet. Demandez un nouveau lien \\u00e0 l\\u2019assistant.",exp:"Ce lien a expir\\u00e9. Demandez un nouveau lien \\u00e0 l\\u2019assistant.",
up:"D\\u00e9poser un fichier",dest:"Destination : ",max:"Taille maximale : ",ow1:"Un fichier existant \\u00e0 cet emplacement sera remplac\\u00e9.",ow0:"Le fichier ne doit pas d\\u00e9j\\u00e0 exister.",
send:"Envoyer",big:"Fichier trop volumineux.",empty:"Fichier vide.",sending:"Envoi\\u2026 ",ok:"Fichier re\\u00e7u. Retournez \\u00e0 la conversation : l\\u2019assistant peut v\\u00e9rifier la r\\u00e9ception.",
net:"Erreur r\\u00e9seau. V\\u00e9rifiez la connexion puis r\\u00e9essayez.",denied:"Refus\\u00e9 : lien expir\\u00e9 ou invalide.",fail:"\\u00c9chec de l\\u2019envoi",retry:"R\\u00e9essayer",
dl:"T\\u00e9l\\u00e9charger le fichier",dlh:"Ensuite, joignez le fichier \\u00e0 la conversation si l\\u2019assistant en a besoin.",until:"Lien valable jusqu\\u2019\\u00e0 ",type:"Type attendu : "}
:{bad:"Invalid or incomplete link. Ask the assistant for a new one.",exp:"This link has expired. Ask the assistant for a new one.",
up:"Upload a file",dest:"Destination: ",max:"Maximum size: ",ow1:"A file already at this location will be replaced.",ow0:"The file must not already exist.",
send:"Upload",big:"File too large.",empty:"Empty file.",sending:"Uploading\\u2026 ",ok:"File received. Go back to the conversation: the assistant can verify it arrived.",
net:"Network error. Check the connection and try again.",denied:"Refused: link expired or invalid.",fail:"Upload failed",retry:"Try again",
dl:"Download the file",dlh:"Then attach the file to the conversation if the assistant needs it.",until:"Link valid until ",type:"Expected type: "};
var m=document.getElementById("m");
function el(t,x,c){var e=document.createElement(t);if(x)e.textContent=x;if(c)e.className=c;m.appendChild(e);return e}
function stop(x){el("p",x,"err")}
function size(n){var u=["B","KB","MB","GB"],i=0;while(n>=1024&&i<3){n/=1024;i++}return(i?n.toFixed(1):n)+" "+u[i]}
var d;try{var h=location.hash.slice(1).replace(/-/g,"+").replace(/_/g,"/");
d=JSON.parse(decodeURIComponent(escape(atob(h))))}catch(e){return stop(T.bad)}
if(!d||d.v!==1||typeof d.path!=="string"||typeof d.exp!=="number")return stop(T.bad);
if(Date.now()>d.exp)return stop(T.exp);
var name=d.path.split("/").pop();
if(d.op==="download"){
if(typeof d.url!=="string"||d.url.charAt(0)!=="/"||/^\\/[\\/\\\\]/.test(d.url))return stop(T.bad);
el("h1",name);var a=el("a",T.dl,"btn");a.href=d.url;a.setAttribute("download",name);
el("p",T.dlh);el("p",T.until+new Date(d.exp).toLocaleString(),"muted");return}
if(d.op!=="upload"||!d.fields||typeof d.max!=="number")return stop(T.bad);
el("h1",T.up);el("p",T.dest+d.path);el("p",T.max+size(d.max));
if(d.type&&d.type!=="application/octet-stream")el("p",T.type+d.type);
el("p",d.overwrite?T.ow1:T.ow0,"muted");el("p",T.until+new Date(d.exp).toLocaleString(),"muted");
var f=el("input");f.type="file";if(d.type&&d.type!=="application/octet-stream")f.accept=d.type;
var b=el("button",T.send);b.disabled=true;var g=el("progress");g.max=100;g.hidden=true;var s=el("p","","st");
f.onchange=function(){var x=f.files[0];s.textContent="";s.className="st";
b.disabled=!x||x.size>d.max||x.size<1;if(x&&x.size>d.max)s.textContent=T.big;else if(x&&x.size<1)s.textContent=T.empty};
b.onclick=function(){var x=f.files[0];if(!x||Date.now()>d.exp){s.textContent=T.exp;return}
b.disabled=f.disabled=true;g.hidden=false;g.value=0;s.className="st";
var fd=new FormData();for(var k in d.fields)fd.append(k,d.fields[k]);fd.append("file",x);
var q=new XMLHttpRequest();q.open("POST","/");
q.upload.onprogress=function(e){if(e.lengthComputable){g.value=Math.floor(e.loaded*100/e.total);s.textContent=T.sending+g.value+" %"}};
q.onload=function(){if(q.status===201||q.status===204||q.status===200){g.value=100;s.textContent=T.ok;s.className="st ok";return}
var c=(/<Code>([^<]+)<\\/Code>/.exec(q.responseText||"")||[])[1]||String(q.status);
s.textContent=c==="EntityTooLarge"?T.big:c==="AccessDenied"?T.denied:T.fail+" ("+c+").";s.className="st err";again()};
q.onerror=function(){s.textContent=T.net;s.className="st err";again()};q.send(fd)};
function again(){g.hidden=true;f.disabled=false;b.disabled=false;b.textContent=T.retry}
})();`;
