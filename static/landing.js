"use strict";
/* ═══════════════════════════════════════════════════════════════════════════
   ThermaLens — landing page
   Runs after app.js. The dashboard boots in the background behind the landing
   overlay, so "Launch dashboard" is instant and the landing page can show
   real figures from the same API. It never calls anything the dashboard does
   not already call, and never invents a number: until the API answers, every
   figure is a dash.
   ═══════════════════════════════════════════════════════════════════════════ */
(function(){
  const L=document.getElementById("landing");
  if(!L)return;
  const q=(s,r)=>(r||document).querySelector(s);
  const qa=(s,r)=>Array.from((r||document).querySelectorAll(s));
  const html=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const reduce=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const BANDS=["Low","Moderate","High","Severe"];
  const BAND_HEX=["#10b981","#f59e0b","#f97316","#ef4444"];
  let appReady=false,appFailed=false;

  /* ── Routing: landing at "/", dashboard at "#dashboard" ── */
  function inApp(){return L.classList.contains("hidden");}
  function afterReady(fn){
    if(appReady)fn();
    else document.addEventListener("thermalens:ready",()=>fn(),{once:true});
  }
  function showApp(){
    L.classList.add("hidden");
    document.body.classList.add("in-app");
    requestAnimationFrame(()=>{try{if(st.map)st.map.resize();}catch(e){}});
  }
  function showLanding(){
    L.classList.remove("hidden");
    document.body.classList.remove("in-app");
    L.scrollTop=0;
    kickGlobe();
  }
  function enterApp(o){
    o=o||{};
    if(location.hash!=="#dashboard")history.pushState({app:1},"","#dashboard");
    showApp();
    if(!o.city&&!o.preview&&!o.log)return;
    afterReady(async()=>{
      try{
        if(o.city)await openCity(o.city);
        else if(o.preview&&st.cities&&st.cities[0])await openCity(st.cities[0].id);
        if(o.preview)setTimeout(()=>{if(typeof toggleSimPop==="function")toggleSimPop(true);},60);
        if(o.log)setTimeout(()=>{const b=q("#outbox");if(b)b.click();},60);
      }catch(e){console.warn("landing launch:",e);}
    });
  }
  function route(){
    if(location.hash==="#dashboard"){if(!inApp())showApp();}
    else if(inApp())showLanding();
  }
  window.addEventListener("popstate",route);
  window.addEventListener("hashchange",route);
  if(location.hash==="#dashboard")showApp();

  /* Brand in the dashboard header leads back to the overview. */
  const appBrand=q(".topbar .brand");
  if(appBrand){
    appBrand.setAttribute("data-home","");appBrand.setAttribute("role","link");
    appBrand.setAttribute("tabindex","0");appBrand.setAttribute("title","Back to ThermaLens overview");
    const back=()=>{if(location.hash==="#dashboard")history.pushState({},"",location.pathname+location.search);showLanding();};
    appBrand.addEventListener("click",back);
    appBrand.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();back();}});
  }

  /* ── Launch, preview and log controls ── */
  qa("[data-launch]").forEach(el=>{
    el.addEventListener("click",()=>enterApp());
    el.addEventListener("keydown",e=>{if((e.key==="Enter"||e.key===" ")&&el.tagName!=="BUTTON"){e.preventDefault();enterApp();}});
  });
  const pv=()=>enterApp({preview:true});
  q("#heroPreview").addEventListener("click",pv);
  q("#finalPreview").addEventListener("click",pv);
  const lg=()=>enterApp({log:true});
  q("#openLog").addEventListener("click",lg);
  const fl=q("#footLog");
  fl.addEventListener("click",lg);
  fl.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();lg();}});

  /* ── Smooth in-page navigation (no hash change, so routing stays clean) ── */
  function scrollToId(id){
    if(id==="top"){L.scrollTo({top:0,behavior:reduce?"auto":"smooth"});return;}
    const el=document.getElementById(id);
    if(!el)return;
    const nav=q("#lNav");
    const y=el.getBoundingClientRect().top-L.getBoundingClientRect().top+L.scrollTop-(nav?nav.offsetHeight-1:0);
    L.scrollTo({top:y,behavior:reduce?"auto":"smooth"});
  }
  qa("[data-scroll]",L).forEach(el=>{
    el.addEventListener("click",e=>{
      e.preventDefault();closeMenu();scrollToId(el.getAttribute("data-scroll"));
    });
    el.addEventListener("keydown",e=>{if(e.key==="Enter"&&el.tagName!=="BUTTON"&&el.tagName!=="A"){e.preventDefault();scrollToId(el.getAttribute("data-scroll"));}});
  });

  /* Mobile menu */
  const burger=q("#lBurger"),mob=q("#lMobile");
  function closeMenu(){mob.classList.remove("open");burger.setAttribute("aria-expanded","false");}
  burger.addEventListener("click",()=>{
    const o=mob.classList.toggle("open");burger.setAttribute("aria-expanded",String(o));
  });
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!inApp())closeMenu();});

  /* Nav shadow and active section */
  const nav=q("#lNav");
  L.addEventListener("scroll",()=>nav.classList.toggle("scrolled",L.scrollTop>8),{passive:true});
  const links=qa(".l-links a[data-scroll], .l-mobile a[data-scroll]",L);
  const secIds=["why","capabilities","how","cities","alerts","faq"];
  const secEls=secIds.map(id=>document.getElementById(id)).filter(Boolean);
  let activeId=undefined,spyTick=false;
  function spy(){
    spyTick=false;
    const top=L.getBoundingClientRect().top,line=nav.offsetHeight+L.clientHeight*.3;
    let cur=null;
    secEls.forEach(el=>{if(el.getBoundingClientRect().top-top<=line)cur=el.id;});
    if(L.scrollTop+L.clientHeight>=L.scrollHeight-4)cur=secIds[secIds.length-1];
    if(cur===activeId)return;
    activeId=cur;
    links.forEach(a=>{
      const on=a.getAttribute("data-scroll")===cur;
      a.classList.toggle("on",on);
      if(on)a.setAttribute("aria-current","location");else a.removeAttribute("aria-current");
    });
  }
  L.addEventListener("scroll",()=>{if(!spyTick){spyTick=true;requestAnimationFrame(spy);}},{passive:true});
  window.addEventListener("resize",spy);
  spy();
  if("IntersectionObserver" in window){
    const rv=new IntersectionObserver(es=>{
      es.forEach(en=>{if(en.isIntersecting){en.target.classList.add("in");rv.unobserve(en.target);}});
    },{root:L,rootMargin:"0px 0px -8% 0px",threshold:.08});
    qa(".reveal",L).forEach(el=>rv.observe(el));
  }else{L.classList.add("no-js");}

  /* ── Sign in dialog ──
     No account service exists in this codebase, so the form never pretends to
     authenticate. If the host page defines window.thermalensSignIn(credentials)
     it is called (may return a promise); otherwise the user is told plainly. */
  (function signIn(){
    const modal=q("#signinModal"),form=q("#signinForm"),msg=q("#siMsg");
    if(!modal||!form)return;
    let opener=null;
    const focusable=()=>qa("button,input",modal).filter(e=>!e.disabled&&e.offsetParent!==null);
    function open(from){
      opener=from||document.activeElement;closeMenu();
      modal.hidden=false;L.classList.add("modal-open");msg.textContent="";msg.className="l-signin-msg";
      requestAnimationFrame(()=>{modal.classList.add("open");q("#siEmail").focus();});
    }
    function close(){
      modal.classList.remove("open");L.classList.remove("modal-open");
      setTimeout(()=>{modal.hidden=true;},reduce?0:250);
      if(opener&&opener.focus)opener.focus();
    }
    qa("[data-signin]",L).forEach(a=>{
      a.addEventListener("click",e=>{e.preventDefault();open(a);});
      a.addEventListener("keydown",e=>{if(e.key===" "){e.preventDefault();open(a);}});
    });
    qa("[data-close-signin]",modal).forEach(b=>b.addEventListener("click",close));
    modal.addEventListener("click",e=>{if(e.target===modal)close();});
    document.addEventListener("keydown",e=>{
      if(modal.hidden)return;
      if(e.key==="Escape")close();
      if(e.key==="Tab"){
        const f=focusable();if(!f.length)return;
        const a=f[0],z=f[f.length-1];
        if(e.shiftKey&&document.activeElement===a){e.preventDefault();z.focus();}
        else if(!e.shiftKey&&document.activeElement===z){e.preventDefault();a.focus();}
      }
    });
    q("#signinSkip").addEventListener("click",()=>{opener=null;close();enterApp();});
    form.addEventListener("submit",async e=>{
      e.preventDefault();
      const email=q("#siEmail").value.trim(),password=q("#siPass").value;
      if(!email||!password){msg.className="l-signin-msg err";msg.textContent="Enter your email and password.";return;}
      if(typeof window.thermalensSignIn!=="function"){
        msg.className="l-signin-msg err";
        msg.textContent="Sign in is not connected to an account service yet. You can continue to the dashboard below.";
        return;
      }
      try{
        msg.className="l-signin-msg";msg.textContent="Signing in…";
        await window.thermalensSignIn({email,password});
        msg.textContent="Signed in.";close();
      }catch(err){msg.className="l-signin-msg err";msg.textContent=(err&&err.message)||"Could not sign in.";}
    });
  })();
  q("#yr").textContent=new Date().getFullYear();

  /* ── Ramps share the dashboard's own constants, so they cannot drift ── */
  try{
    q("#rampU").style.background=rampCSS(RAMP_UTCI);
    q("#rampV").style.background=rampCSS(RAMP_VEG);
  }catch(e){}

  /* ═══ Interactive sample grid ═══ */
  (function demo(){
    const grid=q("#demoGrid"),range=q("#demoRange"),val=q("#demoVal"),tally=q("#demoTally");
    const COLS=14,ROWS=6,N=COLS*ROWS;
    /* Smooth deterministic field, so neighbouring cells read as a district. */
    const f=(x,y)=>{
      const a=Math.sin(x*.55+1.3)*Math.cos(y*.7+.4);
      const b=Math.sin(x*.21-y*.33+2.1);
      const c=Math.cos((x+y)*.38);
      return (a*.5+b*.3+c*.2+1)/2;
    };
    const base=[];
    for(let i=0;i<N;i++){base.push(f(i%COLS,Math.floor(i/COLS)));}
    const cells=[];
    for(let i=0;i<N;i++){const c=document.createElement("i");grid.appendChild(c);cells.push(c);}
    function paint(){
      const off=+range.value;
      val.textContent="+"+off+" °C";
      const counts=[0,0,0,0];
      base.forEach((v,i)=>{
        const s=v*.62+off*.055;
        const b=s<.34?0:s<.52?1:s<.7?2:3;
        counts[b]++;cells[i].style.background=BAND_HEX[b];
      });
      tally.innerHTML=BANDS.map((b,k)=>`<span><i style="background:${BAND_HEX[k]}"></i>${b} ${counts[k]}</span>`).join("");
    }
    range.addEventListener("input",paint);
    paint();
  })();

  /* ═══ Live figures and city cards ═══ */
  const setFact=(id,v)=>{const el=q("#"+id);if(!el)return;el.textContent=v;el.classList.remove("skel");};
  function weatherSummary(){
    const cs=st.cities||[];
    if(!cs.length)return{n:0,live:0};
    return{n:cs.length,live:cs.filter(c=>c.weather_prov==="live").length};
  }
  function hydrate(){
    const cs=st.cities||[];
    setFact("fCities",cs.length?String(cs.length):"0");
    const fromIndia=(st.india&&st.india.cities)||[];
    let wards=0,known=false;
    cs.forEach(c=>{
      const n=c.n_wards!=null?c.n_wards:(fromIndia.find(x=>x.id===c.id)||{}).n_wards;
      if(typeof n==="number"){wards+=n;known=true;}
    });
    setFact("fWards",known?String(wards):"n/a");
    const w=weatherSummary();
    setFact("fWeather",w.n?`${w.live} of ${w.n}`:"n/a");

    const lamp=q("#chipLamp"),t=q("#chipLiveT"),s=q("#chipLiveS");
    if(!w.n){lamp.className="lamp stale";t.textContent="No city data";s.textContent="The API returned no cities";}
    else if(w.live===w.n){lamp.className="lamp ok";t.textContent="Live weather";s.textContent=w.n+" pilot cities reporting";}
    else if(w.live>0){lamp.className="lamp stale";t.textContent="Partly live";s.textContent=w.live+" of "+w.n+" cities on live weather";}
    else{lamp.className="lamp stale";t.textContent="Fallback weather";s.textContent="Live feeds not reachable";}

    renderCities();
    renderGlobeCities();
    globe.setCities();
    loadHigh(0);
  }
  function failed(msg){
    appFailed=true;
    ["fCities","fWards","fWeather","fHigh"].forEach(id=>setFact(id,"n/a"));
    q("#chipLamp").className="lamp stale";
    q("#chipLiveT").textContent="API unreachable";
    q("#chipLiveS").textContent="Start the backend to see live data";
    q("#lCities").innerHTML=`<div class="l-empty">Pilot cities could not be loaded${msg?": "+html(msg):""}. You can still open the dashboard once the API is running.</div>`;
  }
  async function loadHigh(attempt){
    try{
      const w=await api("/api/india/watch");
      if(w&&w.warming){
        if(attempt<20)setTimeout(()=>loadHigh(attempt+1),3000);
        else setFact("fHigh","n/a");
        return;
      }
      const b=((w||{}).total||{}).bands||{};
      setFact("fHigh",String((b.High||0)+(b.Severe||0)));
      paintBandsOnCards((w&&w.cities)||[]);
      try{paintCityPins((w&&w.cities)||[]);}catch(e){}
    }catch(e){
      if(attempt<4)setTimeout(()=>loadHigh(attempt+1),4000);else setFact("fHigh","n/a");
    }
  }
  function renderCities(){
    const mount=q("#lCities"),cs=st.cities||[];
    if(!cs.length){mount.innerHTML=`<div class="l-empty">No pilot cities are available from the API yet.</div>`;return;}
    const fromIndia=(st.india&&st.india.cities)||[];
    mount.innerHTML=cs.map((c,i)=>{
      const n=c.n_wards!=null?c.n_wards:(fromIndia.find(x=>x.id===c.id)||{}).n_wards;
      const live=c.weather_prov==="live";
      return `<button class="l-city reveal in" type="button" data-city="${html(c.id)}" style="--d:${i*60}ms">
        <span class="pill ${live?"":"stale"}"><i></i>${live?"Live weather":"Fallback weather"}</span>
        <span><span class="st">${html(c.state||"")}</span><h3>${html(c.name)}</h3></span>
        <span class="meta"><span data-meta>${typeof n==="number"?n+" wards":"Ward map"}</span><span class="go">Open map <svg class="i" style="width:16px;height:16px"><use href="#i-arrow"/></svg></span></span>
      </button>`;
    }).join("");
    qa(".l-city",mount).forEach(b=>b.addEventListener("click",()=>enterApp({city:b.getAttribute("data-city")})));
  }
  function paintBandsOnCards(list){
    list.forEach(c=>{
      const card=q(`.l-city[data-city="${CSS.escape(String(c.city))}"] [data-meta]`);
      if(!card)return;
      const b=BANDS[Math.max(c.worst_htsi||0,c.worst_mort||0)]||"Low";
      const n=c.n_wards;
      card.innerHTML=`${typeof n==="number"?n+" wards, ":""}peak <b style="color:${BAND_HEX[BANDS.indexOf(b)]}">${b}</b>`;
    });
  }
  function renderGlobeCities(){
    const mount=q("#globeCities"),cs=st.cities||[];
    if(!cs.length){mount.innerHTML="";return;}
    mount.innerHTML=`<span class="lab">Open a city</span>`+cs.map(c=>`<button class="l-pill" type="button" data-city="${html(c.id)}"><i></i>${html(c.name)}</button>`).join("");
    qa(".l-pill",mount).forEach(b=>b.addEventListener("click",()=>enterApp({city:b.getAttribute("data-city")})));
  }

  document.addEventListener("thermalens:ready",()=>{appReady=true;hydrate();});
  document.addEventListener("thermalens:error",e=>{failed(e.detail);});

  /* ═══ Rotating globe ═══
     Orthographic dot-matrix Earth drawn on a 2D canvas. Land comes from a
     public country GeoJSON rasterised once to a mask; each frame only projects
     a few thousand precomputed points. India is lit in the heat ramp, and the
     pilot cities are real pins that open their ward map. The heat shimmer is
     decorative and carries no data. */
  const globe=(function(){
    const cv=q("#globe"),box=q("#globeBox");
    const ctx=cv.getContext("2d");
    const GEO=[
      "https://cdn.jsdelivr.net/gh/johan/world.geo.json@master/countries.geo.json",
      "https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json"
    ];
    const D2R=Math.PI/180;
    let W=0,H=0,R=0,cx=0,cy=0,DPR=1;
    let lam0=135,phi0=21;                 /* centre longitude and tilt, degrees */
    const SPEED=7;                         /* degrees per second, eastward spin */
    let dots=[],pins=[],hits=[];
    let running=false,visible=true,last=0,vel=0;
    let dragging=false,moved=0,downX=0,lastX=0,lastT=0;
    const HEAT=[[245,158,11],[249,115,22],[239,68,68]];
    const palette=[];
    for(let i=0;i<48;i++){
      const t=i/47*2,k=Math.min(1,Math.floor(t)),f=t-k,a=HEAT[k],b=HEAT[Math.min(2,k+1)];
      palette.push(`rgb(${Math.round(a[0]+(b[0]-a[0])*f)},${Math.round(a[1]+(b[1]-a[1])*f)},${Math.round(a[2]+(b[2]-a[2])*f)})`);
    }
    /* Graticule, precomputed once as radian points. */
    const grat=[];
    for(let lo=-180;lo<180;lo+=30){const l=[];for(let la=-84;la<=84;la+=6)l.push([lo*D2R,la*D2R]);grat.push(l);}
    for(let la=-60;la<=60;la+=30){const l=[];for(let lo=-180;lo<=180;lo+=6)l.push([lo*D2R,la*D2R]);grat.push(l);}

    function size(){
      const r=cv.getBoundingClientRect();
      DPR=Math.min(2,window.devicePixelRatio||1);
      W=Math.max(1,r.width);H=Math.max(1,r.height);
      cv.width=Math.round(W*DPR);cv.height=Math.round(H*DPR);
      ctx.setTransform(DPR,0,0,DPR,0,0);
      cx=W/2;cy=H/2;R=Math.min(W,H)*.40;
    }

    /* Land mask from GeoJSON: equirectangular raster, 2 px per degree. */
    function rings(g){
      if(!g)return[];
      if(g.type==="Polygon")return[g.coordinates];
      if(g.type==="MultiPolygon")return g.coordinates;
      return[];
    }
    function mask(features,filter){
      const c=document.createElement("canvas");c.width=720;c.height=360;
      const g=c.getContext("2d",{willReadFrequently:true});
      g.fillStyle="#000";
      features.forEach(f=>{
        if(!filter(f))return;
        rings(f.geometry).forEach(poly=>{
          g.beginPath();
          poly.forEach(ring=>{
            ring.forEach((p,i)=>{const x=(p[0]+180)*2,y=(90-p[1])*2;if(i)g.lineTo(x,y);else g.moveTo(x,y);});
            g.closePath();
          });
          g.fill("evenodd");
        });
      });
      return g.getImageData(0,0,720,360).data;
    }
    const lit=(d,lon,lat)=>{
      const x=Math.min(719,Math.max(0,Math.floor((lon+180)*2))),y=Math.min(359,Math.max(0,Math.floor((90-lat)*2)));
      return d[(y*720+x)*4+3]>110;
    };
    async function loadLand(){
      let geo=null;
      for(const u of GEO){
        try{const r=await fetch(u);if(r.ok){geo=await r.json();break;}}catch(e){}
      }
      if(!geo||!geo.features)return;
      const land=mask(geo.features,()=>true);
      const ind=mask(geo.features,f=>f.id==="IND"||(f.properties&&f.properties.name==="India"));
      const step=1.7,out=[];
      for(let lat=-80;lat<=82;lat+=step){
        const cl=Math.cos(lat*D2R),ls=step/Math.max(.2,cl);
        for(let lon=-180;lon<180;lon+=ls){
          if(!lit(land,lon,lat))continue;
          out.push({lo:lon*D2R,sl:Math.sin(lat*D2R),cl:cl,lon:lon,lat:lat,ind:lit(ind,lon,lat)?1:0});
        }
      }
      dots=out;
    }

    function setCities(){
      try{pins=(typeof cityPoints==="function"?cityPoints():[]).map(c=>({id:c.id,name:c.name,lo:c.ll[0]*D2R,la:c.ll[1]*D2R}));}
      catch(e){pins=[];}
    }

    function draw(t){
      ctx.clearRect(0,0,W,H);
      const l0=lam0*D2R,p0=phi0*D2R,sp0=Math.sin(p0),cp0=Math.cos(p0);

      /* Atmosphere and a warm under-glow that ties the globe to the heat theme */
      let g=ctx.createRadialGradient(cx,cy,R*.96,cx,cy,R*1.28);
      g.addColorStop(0,"rgba(20,103,240,.20)");g.addColorStop(1,"rgba(20,103,240,0)");
      ctx.fillStyle=g;ctx.beginPath();ctx.arc(cx,cy,R*1.28,0,6.2832);ctx.fill();
      g=ctx.createRadialGradient(cx+R*.5,cy+R*.55,R*.1,cx+R*.5,cy+R*.55,R*1.1);
      g.addColorStop(0,"rgba(255,122,60,.22)");g.addColorStop(1,"rgba(255,122,60,0)");
      ctx.fillStyle=g;ctx.beginPath();ctx.arc(cx+R*.5,cy+R*.55,R*1.1,0,6.2832);ctx.fill();

      /* Sphere */
      g=ctx.createRadialGradient(cx-R*.34,cy-R*.4,R*.12,cx,cy,R);
      g.addColorStop(0,"#ffffff");g.addColorStop(.55,"#eef4fc");g.addColorStop(1,"#cddff4");
      ctx.fillStyle=g;ctx.beginPath();ctx.arc(cx,cy,R,0,6.2832);ctx.fill();
      ctx.lineWidth=1;ctx.strokeStyle="rgba(20,103,240,.22)";ctx.stroke();

      /* Graticule */
      ctx.strokeStyle="rgba(20,103,240,.10)";ctx.lineWidth=.8;
      for(const line of grat){
        ctx.beginPath();let pen=false;
        for(const p of line){
          const dl=p[0]-l0,sl=Math.sin(p[1]),cl=Math.cos(p[1]);
          const cc=sp0*sl+cp0*cl*Math.cos(dl);
          if(cc<=0){pen=false;continue;}
          const x=cx+R*cl*Math.sin(dl),y=cy-R*(cp0*sl-sp0*cl*Math.cos(dl));
          if(pen)ctx.lineTo(x,y);else{ctx.moveTo(x,y);pen=true;}
        }
        ctx.stroke();
      }

      /* Land dots, then India in the heat ramp */
      const tt=t*.0011;
      for(let i=0;i<dots.length;i++){
        const d=dots[i],dl=d.lo-l0,cd=Math.cos(dl);
        const cc=sp0*d.sl+cp0*d.cl*cd;
        if(cc<=.02)continue;
        const x=cx+R*d.cl*Math.sin(dl),y=cy-R*(cp0*d.sl-sp0*d.cl*cd);
        if(d.ind){
          const k=(Math.sin(tt+d.lon*.34+d.lat*.27)+1)/2;
          ctx.globalAlpha=.55+.45*cc;
          ctx.fillStyle=palette[Math.min(47,Math.floor(k*47))];
          const s=1.9+1.1*cc;
          ctx.beginPath();ctx.arc(x,y,s*.62,0,6.2832);ctx.fill();
        }else{
          ctx.globalAlpha=.16+.62*Math.pow(cc,.7);
          ctx.fillStyle="#6f97d4";
          const s=1.15+1.0*cc;
          ctx.fillRect(x-s/2,y-s/2,s,s);
        }
      }
      ctx.globalAlpha=1;

      /* Soft limb darkening for depth */
      g=ctx.createRadialGradient(cx-R*.2,cy-R*.25,R*.55,cx,cy,R);
      g.addColorStop(0,"rgba(40,90,170,0)");g.addColorStop(1,"rgba(40,90,170,.08)");
      ctx.fillStyle=g;ctx.beginPath();ctx.arc(cx,cy,R,0,6.2832);ctx.fill();

      /* City pins, drawn last so they sit on top and are clickable */
      hits=[];
      const wc=(typeof st!=="undefined"&&st._watchCities)||[];
      ctx.font="600 12px Inter,system-ui,sans-serif";ctx.textBaseline="middle";
      for(const p of pins){
        const dl=p.lo-l0,sl=Math.sin(p.la),cl=Math.cos(p.la);
        const cc=sp0*sl+cp0*cl*Math.cos(dl);
        if(cc<=.16)continue;
        const x=cx+R*cl*Math.sin(dl),y=cy-R*(cp0*sl-sp0*cl*Math.cos(dl));
        const w=wc.find(c=>c.city===p.id);
        const bi=w?Math.max(w.worst_htsi||0,w.worst_mort||0):-1;
        const col=bi>=0?BAND_HEX[Math.min(3,bi)]:"#1467f0";
        const ph=((t+p.lo*900)%2200)/2200;
        ctx.globalAlpha=(1-ph)*.5*Math.min(1,cc*2);
        ctx.strokeStyle=col;ctx.lineWidth=2;
        ctx.beginPath();ctx.arc(x,y,6+ph*20,0,6.2832);ctx.stroke();
        ctx.globalAlpha=Math.min(1,cc*3);
        ctx.fillStyle="#fff";ctx.strokeStyle=col;ctx.lineWidth=3.5;
        ctx.beginPath();ctx.arc(x,y,6.5,0,6.2832);ctx.fill();ctx.stroke();
        const tw=ctx.measureText(p.name).width+18,th=24,tx=x+14,ty=y-th/2;
        ctx.shadowColor="rgba(16,35,63,.18)";ctx.shadowBlur=10;ctx.shadowOffsetY=3;
        ctx.fillStyle="#fff";ctx.beginPath();
        if(ctx.roundRect)ctx.roundRect(tx,ty,tw,th,8);else ctx.rect(tx,ty,tw,th);
        ctx.fill();ctx.shadowColor="transparent";ctx.shadowBlur=0;ctx.shadowOffsetY=0;
        ctx.strokeStyle="rgba(208,216,226,.95)";ctx.lineWidth=1;ctx.stroke();
        ctx.fillStyle="#1a3a6b";ctx.fillText(p.name,tx+9,y+.5);
        ctx.globalAlpha=1;
        if(cc>.3)hits.push({id:p.id,x0:x-12,y0:Math.min(ty,y-12),x1:tx+tw,y1:Math.max(ty+th,y+12)});
      }
      ctx.globalAlpha=1;
    }

    function frame(ts){
      if(!running)return;
      const dt=Math.min(.05,(ts-(last||ts))/1000);last=ts;
      if(!dragging){
        if(Math.abs(vel)>.05){lam0-=vel*dt;vel*=Math.pow(.02,dt);}
        else if(!reduce)lam0-=SPEED*dt;
      }
      if(lam0<-180)lam0+=360;if(lam0>180)lam0-=360;
      draw(ts);
      requestAnimationFrame(frame);
    }
    function start(){
      if(running||!visible||document.hidden||inApp())return;
      running=true;last=0;requestAnimationFrame(frame);
    }
    function stop(){running=false;}
    function kickGlobe(){size();if(reduce){draw(performance.now());}start();}

    /* Interaction: drag to spin, click a pin to open that city */
    const pt=e=>{const r=cv.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};};
    const hitAt=p=>hits.find(h=>p.x>=h.x0&&p.x<=h.x1&&p.y>=h.y0&&p.y<=h.y1);
    cv.addEventListener("pointerdown",e=>{
      dragging=true;moved=0;downX=lastX=e.clientX;lastT=performance.now();vel=0;
      cv.setPointerCapture(e.pointerId);cv.classList.add("drag");
    });
    cv.addEventListener("pointermove",e=>{
      const p=pt(e);
      if(dragging){
        const dx=e.clientX-lastX,now=performance.now(),dtm=Math.max(1,now-lastT);
        lam0-=dx*.32;moved+=Math.abs(dx);vel=(dx*.32)/(dtm/1000);
        lastX=e.clientX;lastT=now;
        if(reduce)draw(now);
      }else cv.classList.toggle("hit",!!hitAt(p));
    });
    const up=e=>{
      if(!dragging)return;
      dragging=false;cv.classList.remove("drag");
      if(Math.abs(e.clientX-downX)<5){
        const h=hitAt(pt(e));vel=0;
        if(h)enterApp({city:h.id});
      }
      vel=Math.max(-90,Math.min(90,vel));
    };
    cv.addEventListener("pointerup",up);
    cv.addEventListener("pointercancel",up);
    cv.addEventListener("pointerleave",()=>cv.classList.remove("hit"));

    if("ResizeObserver" in window)new ResizeObserver(()=>{if(box.offsetParent!==null){size();if(!running)draw(performance.now());}}).observe(box);
    if("IntersectionObserver" in window)new IntersectionObserver(es=>{
      visible=es[0].isIntersecting;if(visible)start();else stop();
    },{root:L,threshold:0}).observe(box);
    document.addEventListener("visibilitychange",()=>{if(document.hidden)stop();else start();});

    size();draw(performance.now());
    loadLand().then(()=>{if(!running)draw(performance.now());});
    start();
    return{setCities,kick:kickGlobe};
  })();
  function kickGlobe(){globe.kick();}
  /* Boot may have finished before this script attached its listener. */
  if(typeof st!=="undefined"&&st.cities&&st.cities.length&&st.view){appReady=true;hydrate();}
})();