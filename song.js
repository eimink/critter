function birb(X){
var S=44100,N=4,F=65536,
bpm=180,tpr=6,ni=3,np=1,ol=1,
I=[[1,0,0,4,95,9,0,0,0,0,200,0],[1,0,0,2,5,0,-16,8,0,0,255,0],[1,2,0,4,200,8,0,0,0,0,200,0]],
IC=[1,0,0,0],
EV=[0,0,42,0,0,1,19,200,11,2,31,200,6,2,1,0,6,0,42,0,0,1,19,200,12,2,31,200,6,2,1,0,6,0,42,0,0,1,19,200,12,2,31,200,6,2,1,0,6,0,42,0,0,1,19,200,12,2,31,200,6,2,1,0,6,0,42,0,0,1,19,200,12,2,31,200,6,2,1,0,6,0,42,0,0,1,19,200,12,2,31,200,6,2,1,0,6,0,42,0,0,1,19,200,12,2,31,200,6,2,1,0,6,0,42,0,0,1,19,200,12,2,31,200,6,2,1,0],ei=0,tk=0,et=0,i,c,r
var bf=[6221,6591,6983,7398,7838,8304,8797,9321,9875,10462,11084,11743],
nf=n=>(n=n<0?0:n>95?95:n,((bf[n%12]<<(n/12))+128)>>8),
spt=S*5/((bpm||125)*2)|0,T=117504,
out=new Float32Array(T),ch=[],tc=0
for(c=0;c<N;c++)ch[c]={p:0,f:0,b:0,w:0,n:0,u:F/2,e:0,t:0,a:0,d:0,s:0,r:0,i:0,rv:255,q:0,g:0}


var MG=2.000000
function TR(C,n,ii){C.i=ii;var s=n-2,j=I[ii]
C.n=s;C.b=nf(s);C.f=C.b;C.p=0;C.w=j[0]
C.a=j[2];C.d=j[3];C.s=j[4];C.r=j[5];if(C.a==0){C.e=F;C.t=2}else{C.e=0;C.t=1}
C.q=j[6];C.g=j[7];C.rv=255

}

function R(){while(ei<EV.length&&et+EV[ei]<=tk){et+=EV[ei];c=EV[ei+1];var C=ch[c],n=EV[ei+2],rv=EV[ei+3],fx=0,pm=0,ii=IC[c];ei+=4

if(n==1)C.t=4;else if(n>=2){{TR(C,n,ii)}}
if(rv)C.rv=rv
}}
function K(){R();tk++
for(c=0;c<N;c++){var C=ch[c]
if(C.g){C.b+=C.q<<2;if(C.b<1)C.b=1;C.g--}
C.f=C.b

var e=C.t;if(e==1){C.e+=F/(C.a+1);if(C.e>=F){C.e=F;C.t=2}}
else if(e==2){var g=F*C.s/255;C.e-=(F-g)/(C.d+1);if(C.e<=g){C.e=g;C.t=3}}
else if(e==4){C.e-=C.e/(C.r+1);if(C.e<64){C.e=0;C.t=0}}}}
for(i=0;i<T;i++){if(tc<=0){K();tc=spt}tc--
var v=0;for(c=0;c<N;c++){var C=ch[c];if(!C.t&&!C.e)continue
var h=C.p,s=0

s=h<F/2?(h*4-F)/F:(F*3-h*4)/F
var en=C.e
var cv=s*en*C.rv/F/255*(29819/65536);v+=cv;if(C.w!==5)C.p=(C.p+C.f)%F}v*=MG;out[i]=v>1?1:v<-1?-1:v}
return{o:out,spt:spt,T:T}}