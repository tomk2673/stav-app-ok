(function(root){'use strict';
if(!root.globalThis) root.globalThis=root;
if(!root.structuredClone) root.structuredClone=function(value){return JSON.parse(JSON.stringify(value));};
if(root.crypto&&!root.crypto.randomUUID&&root.crypto.getRandomValues){
 root.crypto.randomUUID=function(){var b=new Uint8Array(16);root.crypto.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h=[];for(var i=0;i<16;i++)h.push((b[i]+256).toString(16).slice(1));return h.slice(0,4).join('')+'-'+h.slice(4,6).join('')+'-'+h.slice(6,8).join('')+'-'+h.slice(8,10).join('')+'-'+h.slice(10).join('');};
}
})(typeof globalThis!=='undefined'?globalThis:window);
