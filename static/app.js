"use strict";
/* ═══════════════════════════════════════════════════════════════════════════
   ThermaLens — frontend
   MapLibre GL JS on keyless Esri raster basemaps. Ward and state polygons are
   real GeoJSON served by the backend and rendered as MapLibre vector layers
   with feature-state driven hover, selection and filtering.

   Views: INDIA → CITY (ward map) → WARD (detail panel)

   Three rules this file holds itself to:
     1. Never invent a value. A missing field renders as a stated gap.
     2. The active layer governs the fill, the legend, the cursor readout and
        the selected-ward labels together, or not at all.
     3. Map event handlers are registered exactly once, in wireMapEvents().
        Layer builders may run many times; they must never call .on().
   ═══════════════════════════════════════════════════════════════════════════ */

const $=s=>document.querySelector(s);
const $$=s=>document.querySelectorAll(s);
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

/* ── Risk ramp. Byte-identical to the --low/--mod/--high/--sev/--nodata
      custom properties in styles.css. Changing one without the other makes
      the map disagree with its own legend. Original ThermaLens colors preserved. ── */
const BCOL={"Low":"#2e9e5b","Moderate":"#e8a51d","High":"#f0722c","Severe":"#dd3a3a","Insufficient":"#c7d0db"};
const _WCOL=BCOL;
const _WBAND=["Low","Moderate","High","Severe"];
const NODATA="#c7d0db";
const DIMCOL="#d0d8e2";

/* ── Layer metadata: one source of truth for the name, the unit and the
      sentence that explains what the number is. ── */
const LAYERS={
  htsi:{name:"Heat-health risk",unit:"HTSI index",kind:"band",
        note:"Composite of hazard, vulnerability, exposure and adaptive capacity."},
  mort:{name:"Mortality risk",unit:"risk band",kind:"band",
        note:"Modelled excess-mortality risk. Calibration basis is shown per city in the ward panel."},
  hosp:{name:"Hospitalisation spike",unit:"risk band",kind:"band",
        note:"Modelled admissions-surge risk. Coefficients are defaults unless a city shows a fitted basis."},
  utci:{name:"Thermal stress",unit:"UTCI °C",kind:"ramp",
        note:"Universal Thermal Climate Index from air temperature, humidity, wind and solar radiation."},
  veg:{name:"Vegetation cover",unit:"% of ward area",kind:"ramp",
        note:"Fraction of the ward under vegetation, from satellite basemap analysis."}
};

/* ── Continuous ramps. The map expression and the legend bar are both built
      from these arrays, so they cannot drift apart. Neither reuses the risk
      ramp, because neither quantity is a risk band. ── */
const RAMP_UTCI=[[22,"#2C5F8A"],[28,"#63A0C4"],[33,"#E3D3A4"],[38,"#DE883C"],[44,"#BF362C"]];
const RAMP_VEG=[[0,"#6B5540"],[10,"#9A8A52"],[22,"#6E9A4E"],[32,"#3C7F3E"],[45,"#1F5E2E"]];

/* ── Basemaps: keyless Esri raster tiles ── */
const ESRI_ATTR='Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ';
function mkStyle(name,url,ref){
  const s={version:8,name,sources:{"base":{type:"raster",tiles:[url],tileSize:256,attribution:ESRI_ATTR,maxzoom:18}},
    glyphs:"https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
    layers:[{id:"base",type:"raster",source:"base",paint:{"raster-fade-duration":200}}]};
  if(ref){
    s.sources["ref"]={type:"raster",tiles:[ref],tileSize:256,maxzoom:18};
    s.layers.push({id:"ref",type:"raster",source:"ref"});
  }
  return s;
}
const MAP_STYLES={
  dark:mkStyle("Dark",
    "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}"),
  light:mkStyle("Light",
    "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}"),
  satellite:mkStyle("Satellite",
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"),
  streets:mkStyle("Streets",
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}")
};
/* Ward labels need light text on dark grounds and dark text on light grounds. */
const LABEL_INK={dark:["#E7EDF3","rgba(0,0,0,.75)"],light:["#1B2733","rgba(255,255,255,.85)"],
                 satellite:["#FFFFFF","rgba(0,0,0,.72)"],streets:["#1B2733","rgba(255,255,255,.85)"]};
/* Ward outlines must retain contrast when the raster basemap changes. */
const BORDER_INK={dark:"rgba(255,255,255,.48)",light:"rgba(16,35,63,.42)",
                  satellite:"rgba(255,255,255,.82)",streets:"rgba(16,35,63,.58)"};

/* ── Utilities ── */
async function api(p,opts){
  const r=await fetch(p,Object.assign({headers:{"Content-Type":"application/json"}},opts));
  if(!r.ok)throw new Error((await r.text()).slice(0,140));
  return r.json();
}
/* Fixed precision everywhere a value is compared down a column. */
const n3=v=>(v==null||isNaN(v))?"—":Number(v).toFixed(3);
const n1=v=>(v==null||isNaN(v))?"—":Number(v).toFixed(1);
const pct=v=>(v==null||isNaN(v))?"—":Math.round(v*100)+"%";
const deg=v=>(v==null||isNaN(v))?"—":Number(v).toFixed(1)+" °C";

function ist(ts){
  if(!ts)return "";
  let t=String(ts);
  if(!/(Z|[+-]\d\d:?\d\d)$/.test(t))t+="Z";
  const d=new Date(t);
  if(isNaN(d))return String(ts).slice(0,16).replace("T"," ")+" UTC";
  return new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Kolkata",year:"numeric",month:"short",
    day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(d).replace(",","")+" IST";
}
function centroid(geom){
  if(!geom)return null;
  let ring;
  if(geom.type==="MultiPolygon") ring=geom.coordinates.reduce((a,b)=>a[0].length>b[0].length?a:b)[0];
  else if(geom.type==="Polygon") ring=geom.coordinates[0];
  else return null;
  let sx=0,sy=0;for(const[x,y]of ring){sx+=x;sy+=y;}
  return[sx/ring.length,sy/ring.length];
}
function rampExpr(stops,input){
  const out=["interpolate",["linear"],input];
  stops.forEach(([v,c])=>{out.push(v,c);});
  return out;
}
function rampCSS(stops){
  const lo=stops[0][0],hi=stops[stops.length-1][0],span=(hi-lo)||1;
  return "linear-gradient(90deg,"+stops.map(([v,c])=>`${c} ${Math.round((v-lo)/span*100)}%`).join(",")+")";
}

/* ── Constants ── */
const INDIA_CENTER=[79.0,22.9],INDIA_ZOOM=4.6;
const PILOT_STATES=["Maharashtra","Gujarat","Tamil Nadu","Telangana"];

/* ── State ── */
const st={cal:null,cities:[],india:null,view:"india",city:null,layer:"htsi",geo:null,mapmeta:null,sim:null,
  map:null,ready:null,filterBands:new Set(_WBAND),searchIndex:[],
  _selectedWardId:null,_hoveredIdx:null,_selectedIdx:null,agg:null,current:null,
  currentStyle:"light",is3D:false,simOffset:0,
  _indiaGeo:null,_cityMarkersGeo:null,_wardIdxMap:{},_idxWardMap:{},_wired:false,_pins:[],_watchCities:null};

/* ═══════════════════════════════════════════════════════════════════════════
   STATUS LINE AND CURSOR READOUT
   Two separate surfaces. The status line states where you are and what the
   app is doing; the cursor readout describes the polygon under the pointer.
   Keeping them apart means a stale hover can never read as current state.
   ═══════════════════════════════════════════════════════════════════════════ */
function status(msg,kind){
  const el=$("#mapStatus");if(!el)return;
  el.className="map-status"+(kind?" "+kind:"");
  el.textContent=msg||"";
}
function showHover(html,pt){
  const el=$("#hov");if(!el||!st.map)return;
  el.innerHTML=html;
  const cv=st.map.getCanvas();
  const w=el.offsetWidth||220,h=el.offsetHeight||32;
  let x=pt.x+16,y=pt.y+16;
  if(x+w>cv.clientWidth-8)x=pt.x-w-16;
  if(y+h>cv.clientHeight-8)y=pt.y-h-16;
  el.style.left=Math.max(8,x)+"px";
  el.style.top=Math.max(8,y)+"px";
  el.classList.add("on");
}
function hideHover(){const el=$("#hov");if(el)el.classList.remove("on");}

/* ═══════════════════════════════════════════════════════════════════════════
   MAP INIT
   ═══════════════════════════════════════════════════════════════════════════ */
function initMap(){
  st.map=new maplibregl.Map({
    container:"map",style:MAP_STYLES.light,center:INDIA_CENTER,zoom:INDIA_ZOOM,
    minZoom:3,maxZoom:18,pitch:0,bearing:0,antialias:true,attributionControl:false
  });

  /* Resolved the moment the first style and tiles are up. Captured
     synchronously so a fast cached load cannot fire before we listen. */
  st.ready=new Promise(res=>{
    if(st.map.loaded())res();else st.map.once("load",res);
  });

  st.map.addControl(new maplibregl.AttributionControl({compact:true}),"bottom-right");
  st.map.addControl(new maplibregl.ScaleControl({maxWidth:84,unit:"metric"}),"bottom-right");

  st.map.on("error",e=>{if(e&&e.error)console.warn("map:",e.error.message||e.error);});

  wireMapEvents();
}

function rebuildDataLayers(){
  console.log("rebuildDataLayers called - view:", st.view, "has geo:", !!st.geo, "geo length:", st.geo?.length);
  if(st.view==="india") addIndiaLayers();
  if(st.view==="city"&&st.geo) {
    console.log("Rebuilding ward layers after style change");
    addWardLayers();
  }
}

/* ── Basemap switching ── */
function switchStyle(key){
  if(!MAP_STYLES[key]||key===st.currentStyle)return;
  st.currentStyle=key;
  $$(".style-btn").forEach(b=>{
    const on=b.dataset.style===key;
    b.classList.toggle("on",on);b.setAttribute("aria-pressed",String(on));
  });

  /* Change only the raster tile URLs. Replacing the complete MapLibre style
     destroys GeoJSON sources and layers, while source updates preserve ward
     fills, borders, labels, feature state and event handlers. */
  const style=MAP_STYLES[key],m=st.map;
  const base=m.getSource("base");
  if(base&&base.setTiles)base.setTiles(style.sources.base.tiles);

  const hasRef=!!style.sources.ref;
  if(hasRef){
    const ref=m.getSource("ref");
    if(ref&&ref.setTiles)ref.setTiles(style.sources.ref.tiles);
  }
  if(m.getLayer("ref"))m.setLayoutProperty("ref","visibility",hasRef?"visible":"none");

  /* The ward source/layers stay alive, but their contrast must follow the
     newly selected raster mode. */
  if(m.getLayer("ward-borders"))
    m.setPaintProperty("ward-borders","line-color",buildBorderColor());
  if(m.getLayer("ward-labels")){
    const ink=LABEL_INK[st.currentStyle]||LABEL_INK.light;
    m.setPaintProperty("ward-labels","text-color",ink[0]);
    m.setPaintProperty("ward-labels","text-halo-color",ink[1]);
  }
  m.triggerRepaint();
}

/* ── Flat / Raised. Height encodes the risk band; the legend says so. ── */
function toggle3D(on){
  if(st.is3D===on)return;
  st.is3D=on;
  $("#view2d").classList.toggle("on",!on);$("#view2d").setAttribute("aria-pressed",String(!on));
  $("#view3d").classList.toggle("on",on);$("#view3d").setAttribute("aria-pressed",String(on));
  st.map.easeTo({pitch:on?52:0,duration:600});
  if(st.map.getLayer("ward-fills"))st.map.setLayoutProperty("ward-fills","visibility",on?"none":"visible");
  if(st.map.getLayer("ward-3d"))st.map.setLayoutProperty("ward-3d","visibility",on?"visible":"none");
  renderLegend();
}

/* ═══════════════════════════════════════════════════════════════════════════
   INDIA LAYERS
   ═══════════════════════════════════════════════════════════════════════════ */
function addIndiaLayers(){
  const m=st.map;
  removeIndiaLayers();

  if(st._indiaGeo){
    const fc={type:"FeatureCollection",features:(st._indiaGeo.features||[]).map((f,i)=>({
      ...f,id:i,properties:{...f.properties,pilot:PILOT_STATES.includes((f.properties||{}).name)}}))};
    m.addSource("india-states",{type:"geojson",data:fc});
    /* Pilot states are tinted; everything else is left as basemap. The app
       models four cities, so the map must not suggest national ward cover. */
    m.addLayer({id:"india-fill",type:"fill",source:"india-states",paint:{
      "fill-color":["case",["boolean",["get","pilot"],false],"#1467f0","#000000"],
      "fill-opacity":["case",["boolean",["get","pilot"],false],0.08,0.0]}});
    m.addLayer({id:"india-line",type:"line",source:"india-states",paint:{
      "line-color":["case",["boolean",["get","pilot"],false],"rgba(20,103,240,.5)","rgba(16,35,63,.12)"],
      "line-width":["case",["boolean",["get","pilot"],false],1.6,0.6]}});
  }

  /* Add DOM-based city markers (like the original Leaflet implementation) */
  addCityMarkers();
}

function removeIndiaLayers(){
  const m=st.map;if(!m)return;
  ["india-fill","india-line"].forEach(id=>{if(m.getLayer(id))m.removeLayer(id);});
  ["india-states"].forEach(id=>{if(m.getSource(id))m.removeSource(id);});
  removeCityMarkers();
}

/* ═══════════════════════════════════════════════════════════════════════════
   CITY MARKERS (DOM-based, matching original Leaflet implementation)
   Circles at city centres with white fill and colored border. The border
   updates with the worst risk band from the national watch. These persist
   across style changes, 2D/3D toggles, and zoom levels.
   ═══════════════════════════════════════════════════════════════════════════ */
function addCityMarkers(){
  removeCityMarkers();
  st._cityMarkers=[];
  st._cityMarkerMeta={};
  
  const pts=cityPoints();
  pts.forEach(p=>{
    const el=document.createElement("div");
    el.className="city-marker";
    el.dataset.cityId=p.id;
    el.title=`${p.name}, ${p.state} · ${p.n_wards} wards`;
    el.onclick=()=>openCity(p.id);
    
    /* Match original Leaflet: radius:9px (18px diameter), weight:2.5px border,
       fillColor:#fff, color:#1467f0 (default blue before watch data loads) */
    const marker=new maplibregl.Marker({element:el,anchor:"center"})
      .setLngLat(p.ll)
      .addTo(st.map);
    
    st._cityMarkers.push(marker);
    st._cityMarkerMeta[p.id]={marker,element:el,city:p.id};
  });
  
  /* If watch data already loaded, paint immediately */
  if(st._watchCities)paintCityMarkers();
}

function removeCityMarkers(){
  if(st._cityMarkers){
    st._cityMarkers.forEach(m=>m.remove());
    st._cityMarkers=[];
    st._cityMarkerMeta={};
  }
}

function paintCityMarkers(){
  if(!st._cityMarkerMeta||!st._watchCities)return;
  
  /* Update each marker's border color based on worst risk from watch data.
     Matches original logic: Math.max(worst_htsi, worst_mort) 
     Default color before watch loads: #1467f0 (original ThermaLens blue) */
  st._watchCities.forEach(c=>{
    const meta=st._cityMarkerMeta[c.city];
    if(!meta)return;
    
    const worstIndex=Math.max(c.worst_htsi||0,c.worst_mort||0);
    const band=_WBAND[worstIndex]||"Low";
    const color=BCOL[band]||"#1467f0";
    
    meta.element.style.borderColor=color;
    meta.element.title=`${c.name}, ${c.state} · ${c.n_wards} wards · ${band} risk`;
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   CITY PINS
   Clickable DOM markers, one per pilot city. They sit above the canvas, do not
   depend on glyph or style loading, and survive a basemap switch.
   Coordinates come from /api/cities (the record openCity() flies to), with
   /api/india as a fallback. Anything without a finite [lon, lat] is skipped.
   ═══════════════════════════════════════════════════════════════════════════ */
function cityPoints(){
  const out=[],seen=new Set();
  const add=c=>{
    if(!c||seen.has(c.id))return;
    const ll=c.centre||c.center||(c.lon!=null&&c.lat!=null?[c.lon,c.lat]:null);
    if(!ll||!isFinite(ll[0])||!isFinite(ll[1]))return;
    seen.add(c.id);
    out.push({id:c.id,name:c.name||String(c.id),state:c.state||"",n_wards:c.n_wards,ll:[+ll[0],+ll[1]]});
  };
  const fromIndia=((st.india&&st.india.cities)||[]);
  (st.cities||[]).forEach(c=>{
    const f=fromIndia.find(x=>x.id===c.id);
    add(c.n_wards==null&&f?Object.assign({},c,{n_wards:f.n_wards}):c);
  });
  fromIndia.forEach(add);
  return out;
}

/* Paint city markers with risk band colors */
function paintCityMarkersGL(cities){
  st._watchCities=cities;
  paintCityMarkers();
}

/* ═══════════════════════════════════════════════════════════════════════════
   WARD LAYERS
   Properties are normalised in JavaScript before MapLibre sees them, so every
   style expression stays trivial and type-safe. A GeoJSON source is encoded
   through vector tiles internally, which does not preserve JS booleans or
   nulls reliably — hence the numeric 0/1 flags.
   ═══════════════════════════════════════════════════════════════════════════ */
const BAND_IDX={"Low":1,"Moderate":2,"High":3,"Severe":4};

function normProps(p){
  const avail=p.available===true||p.available==="true"||p.available===1;
  const vegOk=typeof p.veg==="number"&&isFinite(p.veg);
  return {...p,
    _avail:avail?1:0,
    _bi:avail?(BAND_IDX[p.band]||0):0,
    _mi:avail?(BAND_IDX[p.mort]||0):0,
    _hi:avail?(BAND_IDX[p.hosp]||0):0,
    _vegOk:vegOk?1:0,
    /* Sentinels only drive styling. A ward with no vegetation reading is
       never drawn as 0 % — _vegOk sends it to the no-data colour instead. */
    utci:typeof p.utci==="number"?p.utci:0,
    veg:vegOk?p.veg:0,
    htsi:typeof p.htsi==="number"?p.htsi:0
  };
}

function bandMatch(key){
  return ["match",["get",key],1,BCOL.Low,2,BCOL.Moderate,3,BCOL.High,4,BCOL.Severe,NODATA];
}
function buildFillColor(forExtrusion){
  const l=st.layer;
  let base;
  if(l==="utci"){
    base=["case",["==",["get","_avail"],0],NODATA,rampExpr(RAMP_UTCI,["get","utci"])];
  }else if(l==="veg"){
    base=["case",["==",["get","_vegOk"],0],NODATA,rampExpr(RAMP_VEG,["*",["get","veg"],100])];
  }else{
    base=bandMatch(l==="mort"?"_mi":l==="hosp"?"_hi":"_bi");
  }
  /* Extrusion opacity cannot take a data expression in MapLibre, so a filtered
     ward is dimmed through its colour instead. */
  if(forExtrusion)return ["case",["boolean",["feature-state","dim"],false],DIMCOL,base];
  return base;
}
function buildExtrusionHeight(){
  const l=st.layer;
  let base;
  if(l==="utci")base=["*",["get","utci"],12];
  else if(l==="veg")base=["*",["get","veg"],600];
  else base=["match",["get",l==="mort"?"_mi":l==="hosp"?"_hi":"_bi"],4,500,3,350,2,200,1,80,30];
  return ["case",["boolean",["feature-state","dim"],false],6,base];
}
function buildBorderColor(){
  const borderInk=BORDER_INK[st.currentStyle]||BORDER_INK.light;
  return ["case",
    ["boolean",["feature-state","selected"],false],"#8FBEEA",
    ["boolean",["feature-state","hover"],false],"rgba(231,237,243,.8)",
    borderInk];
}

function addWardLayers(){
  const m=st.map;
  console.log("addWardLayers called, st.geo length:", st.geo?.length, "map loaded:", m.loaded(), "style loaded:", m.isStyleLoaded());
  
  removeWardLayers();
  if(!st.geo||!st.geo.length){
    console.warn("addWardLayers: no geo data available");
    return;
  }

  try{
    st._wardIdxMap={};st._idxWardMap={};
    const fc={type:"FeatureCollection",features:st.geo.map((f,i)=>{
      const wid=f.properties.id;
      st._wardIdxMap[wid]=i;st._idxWardMap[i]=wid;
      return{type:"Feature",id:i,geometry:f.geometry,properties:normProps(f.properties)};
    })};
    
    console.log("Adding wards source with", fc.features.length, "features");
    m.addSource("wards",{type:"geojson",data:fc});

    m.addLayer({id:"ward-fills",type:"fill",source:"wards",
      layout:{visibility:st.is3D?"none":"visible"},
      paint:{
        "fill-color":buildFillColor(false),
        "fill-opacity":["case",
          ["boolean",["feature-state","dim"],false],0.07,
          ["boolean",["feature-state","selected"],false],0.88,
          ["boolean",["feature-state","hover"],false],0.8,
          ["==",["get","_avail"],0],0.16,
          0.58],
        "fill-antialias":true,
        "fill-color-transition":{duration:260},
        "fill-opacity-transition":{duration:160}}});

    m.addLayer({id:"ward-3d",type:"fill-extrusion",source:"wards",
      layout:{visibility:st.is3D?"visible":"none"},
      paint:{
        "fill-extrusion-color":buildFillColor(true),
        "fill-extrusion-height":buildExtrusionHeight(),
        "fill-extrusion-base":0,
        "fill-extrusion-opacity":0.8,
        "fill-extrusion-height-transition":{duration:400}}});

    m.addLayer({id:"ward-borders",type:"line",source:"wards",paint:{
      "line-color":buildBorderColor(),
      "line-width":["case",
        ["boolean",["feature-state","selected"],false],2.6,
        ["boolean",["feature-state","hover"],false],1.6,
        1.1]}});

    const ink=LABEL_INK[st.currentStyle]||LABEL_INK.light;
    m.addLayer({id:"ward-labels",type:"symbol",source:"wards",minzoom:11.2,layout:{
      "text-field":["get","label"],"text-size":10.5,"text-allow-overlap":false,
      "text-padding":3,"text-font":["Open Sans Semibold","Arial Unicode MS Bold"]},paint:{
      "text-color":ink[0],"text-halo-color":ink[1],"text-halo-width":1.3,
      "text-opacity":["case",["boolean",["feature-state","dim"],false],0.25,1]}});

    console.log("Ward layers added successfully");
    m.triggerRepaint();
    
    applyFilterDim();
    if(st._selectedWardId!=null)selectWard(st._selectedWardId);
  }catch(e){
    console.error("Error adding ward layers:", e);
    status("Failed to add ward layers: "+e.message,"err");
  }
}

function removeWardLayers(){
  const m=st.map;if(!m)return;
  ["ward-fills","ward-3d","ward-borders","ward-labels"].forEach(id=>{if(m.getLayer(id))m.removeLayer(id);});
  if(m.getSource("wards"))m.removeSource("wards");
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAP EVENTS — registered once for the lifetime of the page.
   MapLibre matches a layer-scoped handler at event time, so registering
   before the layer exists is safe and avoids the handler pile-up that came
   from wiring inside the layer builders.
   ═══════════════════════════════════════════════════════════════════════════ */
function wireMapEvents(){
  if(st._wired)return;
  st._wired=true;
  const m=st.map;

  const wardEnter=e=>{
    if(!e.features||!e.features.length)return;
    m.getCanvas().style.cursor="pointer";
    const idx=e.features[0].id;
    if(st._hoveredIdx!==null&&st._hoveredIdx!==idx)
      m.setFeatureState({source:"wards",id:st._hoveredIdx},{hover:false});
    st._hoveredIdx=idx;
    m.setFeatureState({source:"wards",id:idx},{hover:true});
    showHover(hovHTML(e.features[0].properties),e.point);
  };
  const wardLeave=()=>{
    m.getCanvas().style.cursor="";
    if(st._hoveredIdx!==null){
      m.setFeatureState({source:"wards",id:st._hoveredIdx},{hover:false});
      st._hoveredIdx=null;
    }
    hideHover();
  };
  ["ward-fills","ward-3d"].forEach(id=>{
    m.on("mousemove",id,wardEnter);
    m.on("mouseleave",id,wardLeave);
    m.on("click",id,e=>{if(e.features&&e.features.length)openWard(e.features[0].properties.id);});
  });

  /* City marker interactions */
  ["city-markers","city-halo","city-labels"].forEach(id=>{
    m.on("click",id,e=>{if(e.features&&e.features.length)openCity(e.features[0].properties.id);});
    m.on("mouseenter",id,e=>{
      m.getCanvas().style.cursor="pointer";
      if(e.features&&e.features.length){
        const p=e.features[0].properties;
        showHover(`<b>${esc(p.name)}</b> &nbsp;${p.n_wards} wards`,e.point);
      }
    });
    m.on("mousemove",id,e=>{
      if(e.features&&e.features.length){
        const p=e.features[0].properties;
        showHover(`<b>${esc(p.name)}</b> &nbsp;${p.n_wards} wards`,e.point);
      }
    });
    m.on("mouseleave",id,()=>{m.getCanvas().style.cursor="";hideHover();});
  });

  /* Dragging the map should not leave a tooltip stranded mid-canvas. */
  m.on("dragstart",hideHover);
  m.on("zoomstart",hideHover);
}

function hovHTML(p){
  try{p=typeof p==="string"?JSON.parse(p):p;}catch(e){}
  const label=esc(p.label||p.id||"Ward");
  if(p._avail===0||p.available===false)
    return `<span class="ht-band" style="border:1px dashed #30414F"></span>${label} &nbsp;no data`;
  const sw=b=>`<span class="ht-band" style="background:${BCOL[b]||NODATA}"></span>`;
  if(st.layer==="mort")  return `${sw(p.mort)}${label} &nbsp;mortality <b>${esc(p.mort)}</b>`;
  if(st.layer==="hosp")  return `${sw(p.hosp)}${label} &nbsp;hospitalisation <b>${esc(p.hosp)}</b>`;
  if(st.layer==="utci")  return `${label} &nbsp;UTCI <b>${n1(p.utci)} °C</b> &nbsp;air <b>${n1(p.tair)} °C</b>`;
  if(st.layer==="veg")   return p._vegOk===0
    ? `<span class="ht-band" style="border:1px dashed #30414F"></span>${label} &nbsp;no vegetation reading`
    : `${label} &nbsp;vegetation <b>${Math.round(p.veg*100)}%</b>`;
  return `${sw(p.band)}${label} &nbsp;HTSI <b>${n3(p.htsi)}</b> &nbsp;${esc(p.band)}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════════════════ */
async function boot(){
  try{
    initMap();
    status("Loading pilot-city index…","busy");

    const [a,b]=await Promise.all([api("/api/india"),api("/api/cities")]);
    st.india=a;st.cities=b.cities||[];st.sim=b.sim;
    paintLive();
    /* The preview offset lives on the server, so a reload must not claim LIVE
       while a previous session's preview is still applied. */
    const off=(st.sim&&st.sim.offset)||0;
    st.simOffset=off;
    $("#simRange").value=off;
    $("#simVal").textContent="+"+off+" °C";
    updateSimBadge(off);
    api("/api/calibration").then(j=>{st.cal=j;}).catch(()=>{});

    wireChrome();
    buildSearchIndex();
    warmTrendCache();

    st._indiaGeo=a.states?{type:"FeatureCollection",features:a.states.features||[]}:null;
    /* Create city markers GeoJSON with proper IDs for feature state */
    st._cityMarkersGeo={type:"FeatureCollection",features:(a.cities||[]).map((c,idx)=>({
      type:"Feature",id:idx,
      geometry:{type:"Point",coordinates:c.centre},
      properties:{id:c.id,name:c.name,state:c.state,n_wards:c.n_wards}}))};

    await Promise.race([st.ready,new Promise(r=>setTimeout(r,6000))]);
    renderIndia();
    document.dispatchEvent(new CustomEvent("thermalens:ready"));
  }catch(e){
    document.dispatchEvent(new CustomEvent("thermalens:error",{detail:e.message}));
    status("Could not reach the ThermaLens API: "+e.message,"err");
    $("#side").classList.remove("hidden");
    $("#sidepanel").innerHTML=`<div class="ov-head"><h2>Cannot load data</h2>
      <p>The map chrome is ready, but the backend did not answer.</p></div>
      <div class="cav">${esc(e.message)}</div>
      <p class="prov" style="margin-top:12px">Start the API with
      <code>python backend/main.py</code> and reload
      <code>http://localhost:8000</code>.</p>`;
  }
}

function wireChrome(){
  $("#outbox").onclick=async()=>{
    modal(`<h2>Alert log</h2><p class="prov">Loading…</p>`);
    try{modal(await outboxHTML());}
    catch(e){modal(`<h2>Alert log</h2><div class="cav">Could not load the alert log: ${esc(e.message)}</div>`);}
  };
  $("#mclose").onclick=closeModal;
  $("#modal").addEventListener("click",e=>{if(e.target.id==="modal")closeModal();});
  document.addEventListener("keydown",e=>{
    if(e.key!=="Escape")return;
    if(!$("#modal").classList.contains("hidden")){closeModal();return;}
    if(!$("#searchDrop").classList.contains("hidden")){closeSearchDrop();return;}
    if(!$("#simPop").classList.contains("hidden")){toggleSimPop(false);return;}
    if(!$("#side").classList.contains("hidden"))closeSide();
  });

  $("#crumbRoot").onclick=()=>goIndia();
  $("#crumbCity").onclick=()=>{if(st._selectedWardId)backToCityMap();};

  $("#simToggle").onclick=()=>toggleSimPop();
  $("#simApply").onclick=async()=>{await applySim();toggleSimPop(false);};
  $("#simReset").onclick=async()=>{
    $("#simRange").value=0;$("#simVal").textContent="+0 °C";
    await applySim();
  };
  $("#simRange").oninput=()=>$("#simVal").textContent="+"+$("#simRange").value+" °C";
  document.addEventListener("click",e=>{if(!e.target.closest("#simbar"))toggleSimPop(false);});

  $$("#layers button").forEach(b=>b.onclick=()=>setLayer(b.dataset.l));
  $("#ovBtn").onclick=()=>toggleOverview();
  $("#filterToggle").onclick=()=>{
    const fb=$("#filterbar");
    const open=fb.classList.toggle("hidden")===false;
    $("#filterToggle").setAttribute("aria-expanded",String(open));
  };
  wireFilterDrag();
  $("#sideClose").onclick=()=>closeSide();
  $("#zIn").onclick=()=>st.map.zoomIn();
  $("#zOut").onclick=()=>st.map.zoomOut();
  $("#zHome").onclick=()=>goIndia();
  wireSearch();

  $$(".style-btn").forEach(b=>b.onclick=()=>switchStyle(b.dataset.style));
  $("#view2d").onclick=()=>toggle3D(false);
  $("#view3d").onclick=()=>toggle3D(true);
}

function paintLive(){
  const b=$("#live");if(!b)return;
  if(!st.cities.length){b.className="status-pill";b.textContent="No city data";return;}
  const live=st.cities.filter(c=>c.weather_prov==="live").length;
  if(live===st.cities.length){
    b.className="status-pill liveok";
    b.textContent="Live weather, "+live+" cities";
  }else if(live>0){
    b.className="status-pill stale";
    b.textContent="Live in "+live+" of "+st.cities.length+" cities";
  }else{
    b.className="status-pill stale";
    b.textContent="Fallback weather";
  }
}
function cityInfo(id){return st.cities.find(c=>c.id===id)||null;}
function cityName(id){const c=cityInfo(id);return c?c.name:String(id||"");}

/* ═══════════════════════════════════════════════════════════════════════════
   SEARCH
   ═══════════════════════════════════════════════════════════════════════════ */
async function buildSearchIndex(){
  for(const c of st.cities){
    try{
      const d=await api(`/api/city/${c.id}/wards`);
      (d.features||[]).forEach(f=>{
        const p=f.properties;
        st.searchIndex.push({city:c.id,cityName:c.name,id:p.id,label:p.label,
                             band:p.band,available:p.available});
      });
    }catch(e){/* a city that will not index is still navigable from the map */}
  }
}
function updateSearchPlaceholder(){
  const inp=$("#wardSearch");if(!inp)return;
  inp.placeholder=st.view==="city"?`Search a ward in ${cityName(st.city)}`:"Search a ward";
}
function searchMatches(q){
  q=q.trim().toLowerCase();if(!q)return[];
  const scoped=st.view==="city"?st.searchIndex.filter(w=>w.city===st.city):st.searchIndex;
  return scoped.filter(w=>w.available!==false&&(w.label||"").toLowerCase().includes(q)).slice(0,8);
}
let _searchMatches=[],_searchSel=-1;
function renderSearchDrop(matches){
  _searchMatches=matches;_searchSel=-1;
  const el=$("#searchDrop");
  $("#wardSearch").setAttribute("aria-expanded","true");
  if(!matches.length){
    el.innerHTML=`<div class="sres-empty">No ward matches that name.</div>`;
    el.classList.remove("hidden");return;
  }
  el.innerHTML=matches.map((m,i)=>{
    const ci=cityInfo(m.city);
    const fb=(ci&&ci.weather_prov&&ci.weather_prov!=="live")?`<span class="fb">fallback</span>`:"";
    const where=st.view!=="city"?`<span class="city">${esc(m.cityName)}</span>`:"";
    return `<div class="sres" role="option" id="sres-${i}" data-i="${i}">
      <span class="dot" style="background:${_WCOL[m.band]||NODATA}"></span>
      <span class="lab">${esc(m.label)}</span>${where}${fb}</div>`;
  }).join("");
  el.classList.remove("hidden");
  el.querySelectorAll(".sres").forEach((row,i)=>row.onclick=()=>selectSearchResult(matches[i]));
}
function closeSearchDrop(){
  $("#searchDrop").classList.add("hidden");
  $("#wardSearch").setAttribute("aria-expanded","false");
  _searchSel=-1;
}
function moveSearchSel(d){
  if(!_searchMatches.length)return;
  _searchSel=(_searchSel+d+_searchMatches.length+1)%(_searchMatches.length+1)-0;
  if(_searchSel>=_searchMatches.length)_searchSel=0;
  if(_searchSel<0)_searchSel=_searchMatches.length-1;
  const rows=$("#searchDrop").querySelectorAll(".sres");
  rows.forEach((r,i)=>r.classList.toggle("sel",i===_searchSel));
  const sel=rows[_searchSel];
  if(sel){sel.scrollIntoView({block:"nearest"});$("#wardSearch").setAttribute("aria-activedescendant","sres-"+_searchSel);}
}
async function selectSearchResult(m){
  closeSearchDrop();
  $("#wardSearch").value="";
  if(st.view!=="city"||st.city!==m.city)await openCity(m.city);
  await openWard(m.id);
}
function wireSearch(){
  const inp=$("#wardSearch");
  const run=()=>{
    const q=inp.value;
    if(q.trim())renderSearchDrop(searchMatches(q));else closeSearchDrop();
  };
  inp.addEventListener("input",run);
  inp.addEventListener("focus",run);
  inp.addEventListener("keydown",e=>{
    if(e.key==="ArrowDown"){e.preventDefault();moveSearchSel(1);}
    else if(e.key==="ArrowUp"){e.preventDefault();moveSearchSel(-1);}
    else if(e.key==="Enter"){
      const pick=_searchSel>=0?_searchMatches[_searchSel]:_searchMatches[0];
      if(pick){e.preventDefault();selectSearchResult(pick);}
    }
  });
  document.addEventListener("click",e=>{if(!e.target.closest(".search-float"))closeSearchDrop();});
}

/* ═══════════════════════════════════════════════════════════════════════════
   INDIA VIEW
   ═══════════════════════════════════════════════════════════════════════════ */
function renderIndia(){
  st.view="india";st._selectedWardId=null;st._selectedIdx=null;st.geo=null;
  $("#layerSection").classList.add("hidden");
  $("#filterbar").classList.add("hidden");$("#filterbar").innerHTML="";
  $("#filterToggle").classList.add("hidden");$("#filterToggle").setAttribute("aria-expanded","false");
  $("#simToggle").classList.add("hidden");
  $("#simHint").textContent=st.simOffset>0
    ? "A heatwave preview is applied. Open a city to see its effect."
    : "Open a pilot city to preview a heatwave.";
  $("#ovBtn").classList.remove("hidden");$("#ovBtn").textContent="National summary";
  $("#searchWrap").classList.add("hidden");closeSearchDrop();
  $("#view3d").disabled=true;
  if(st.is3D)toggle3D(false);
  closeSideQuiet();

  $("#crumbRoot").classList.add("cur");$("#crumbRoot").textContent="India";
  $("#sepCrumb").classList.add("hidden");$("#crumbCity").classList.add("hidden");
  $("#sepCrumb2").classList.add("hidden");$("#crumbWard").classList.add("hidden");
  updateSearchPlaceholder();

  removeWardLayers();
  addIndiaLayers();
  renderLegend();
  status("Four pilot cities have ward-level modelling. Select one to open its map.");
  renderSideIndia();
}
async function goIndia(){
  renderIndia();
  st.map.flyTo({center:INDIA_CENTER,zoom:INDIA_ZOOM,pitch:0,bearing:0,duration:900});
}

/* ═══════════════════════════════════════════════════════════════════════════
   NATIONAL WATCH
   ═══════════════════════════════════════════════════════════════════════════ */
async function renderSideIndia(){
  $("#sidepanel").innerHTML=`<div class="ov-head"><h2>National heat-watch</h2>
    <p>Ward-level modelling runs for four pilot cities. Open one to see its wards.</p></div>
    <div id="nwBox"><p class="prov">Loading the latest national scan…</p></div>`;
  loadWatch(0);
}
async function loadWatch(attempt){
  const m=$("#nwBox");if(!m)return;
  try{
    const w=await api("/api/india/watch");
    if(w&&w.warming){
      m.innerHTML=`<p class="prov">The first full ward scan is still running. This page will fill in by itself.</p>`;
      if(attempt<40)setTimeout(()=>loadWatch(attempt+1),3000);
      else m.innerHTML=`<div class="cav">The national scan has not finished. Reload to try again.</div>`;
      return;
    }
    renderWatch(w,m);
  }catch(e){
    if(attempt<10)setTimeout(()=>loadWatch(attempt+1),3000);
    else m.innerHTML=`<div class="cav">National watch unavailable: ${esc(e.message)}</div>`;
  }
}
function renderWatch(w,mount){
  if(!mount)return;
  const cities=w.cities||[],total=w.total||{},bands=total.bands||{};
  paintCityMarkersGL(cities);
  const active=(bands.High||0)+(bands.Severe||0);
  const cards=cities.map(c=>{
    const bb=_WBAND[Math.max(c.worst_htsi||0,c.worst_mort||0)]||"Low";
    const n=c.n_wards||1;
    const seg=_WBAND.map(b=>{
      const k=(c.bands||{})[b]||0;const p=Math.round(k/n*100);
      return p?`<i style="width:${p}%;background:${_WCOL[b]}" title="${b}: ${k} wards"></i>`:"";
    }).join("");
    /* Spans, not divs: a <button> may only contain phrasing content. */
    return `<button class="nw-card" type="button" data-id="${esc(c.city)}">
      <span class="nw-top"><span><span class="nw-city">${esc(c.name)}</span>
        <span class="nw-state">${esc(c.state)}</span></span>
        <span class="nw-pill" style="background:${_WCOL[bb]}">${bb}</span></span>
      <span class="nw-dist">${seg}</span>
      <span class="nw-meta"><span>${c.available} of ${c.n_wards} wards resolved</span>
        <span>peak ${bb}</span></span></button>`;
  }).join("");
  mount.innerHTML=`
    <div class="nw-head"><h3>Latest national scan</h3><span class="nw-ts">${esc(ist(w.ts))}</span></div>
    <div class="nw-sum">
      <span>Wards resolved<b>${total.available||0}</b></span>
      <span>High or Severe<b class="${active?"cSevere":""}">${active}</b></span>
      <span>Pilot cities<b>${cities.length}</b></span>
    </div>
    <div class="nw-grid">${cards}</div>
    <p class="nw-note">The bar under each city shows how its wards divide across the four risk bands.</p>`;
  mount.querySelectorAll(".nw-card").forEach(el=>el.onclick=()=>openCity(el.dataset.id));
}

/* ═══════════════════════════════════════════════════════════════════════════
   CITY VIEW
   ═══════════════════════════════════════════════════════════════════════════ */
const _geomCache={};
async function openCity(id){
  const ci=cityInfo(id);
  if(!ci){status("Unknown city: "+id,"err");return;}

  st.city=id;st.view="city";
  st.filterBands=new Set(_WBAND);
  st._selectedWardId=null;st._selectedIdx=null;

  $("#layerSection").classList.remove("hidden");
  $("#filterToggle").classList.remove("hidden");
  $("#simToggle").classList.remove("hidden");
  updateSimBadge(st.simOffset);   /* restores the strip wording for this view */
  $("#ovBtn").textContent="City overview";
  $("#searchWrap").classList.remove("hidden");
  $("#view3d").disabled=false;
  closeSideQuiet();

  $("#crumbRoot").classList.remove("cur");$("#crumbRoot").textContent="India";
  $("#sepCrumb").classList.remove("hidden");$("#crumbCity").classList.remove("hidden");
  $("#crumbCity").textContent=ci.name;$("#crumbCity").classList.add("cur");
  $("#sepCrumb2").classList.add("hidden");$("#crumbWard").classList.add("hidden");
  updateSearchPlaceholder();

  const [lon,lat]=ci.centre;
  st.map.flyTo({center:[lon,lat],zoom:11,pitch:st.is3D?52:0,duration:1000});
  removeIndiaLayers();
  status("Loading "+ci.name+" wards…","busy");
  await loadWards(false);
}

async function loadWards(fly){
  const city=st.city;
  try{
    if(!_geomCache[city]){
      const g=await api(`/api/city/${city}/geometry`);
      const m={};(g.features||[]).forEach(f=>{m[f.id]=f.geometry;});
      _geomCache[city]=m;
    }
    const gc=_geomCache[city];
    const d=await api(`/api/city/${city}/wards`);
    if(st.city!==city)return;               /* the user moved on while we waited */

    st.geo=(d.features||[]).map(f=>({...f,geometry:gc[f.properties.id]||f.geometry}))
                           .filter(f=>f.geometry);
    st.mapmeta=d.mapmeta;st.sim=d.sim;st.agg=d.aggregate||null;

    addWardLayers();
    setLayer(st.layer,true);
    renderFilterBar();
    renderSideCity();
    allocationCard(city);
    cityTrendCard(city);

    if(fly&&st.geo.length){
      const bounds=new maplibregl.LngLatBounds();
      st.geo.forEach(f=>{const c=centroid(f.geometry);if(c)bounds.extend(c);});
      if(!bounds.isEmpty())st.map.fitBounds(bounds,{padding:48,duration:700});
    }
    const miss=(d.features||[]).length-st.geo.length;
    status(cityName(city)+" — "+st.geo.length+" wards. Select one for its full profile."
      +(miss>0?" "+miss+" wards have no boundary on file.":""));
  }catch(e){
    status("Could not load "+cityName(city)+": "+e.message,"err");
  }
}

/* ── Risk-band filter ── */
function renderFilterBar(){
  const fb=$("#filterbar");
  if(st.view!=="city"){fb.classList.add("hidden");fb.innerHTML="";return;}
  const counts={Low:0,Moderate:0,High:0,Severe:0};
  let nodata=0;
  (st.geo||[]).forEach(f=>{
    const b=f.properties.band;
    if(counts[b]!=null)counts[b]++;else nodata++;
  });
  const allOn=st.filterBands.size===_WBAND.length;
  fb.innerHTML=`
    <div class="filterbar-head"><span class="filterbar-grip" title="Drag to move">⠿</span>Risk band
      <button class="filterbar-x" id="filterClose" type="button" aria-label="Close filter">×</button></div>
    <div class="filterbar-list">
      <div class="fchip fchip-all${allOn?" on":""}" data-all="1" role="checkbox"
           aria-checked="${allOn}" tabindex="0">Show all</div>
      ${_WBAND.map(b=>{
        const on=st.filterBands.has(b);
        return `<div class="fchip${on?" on":""}" data-b="${b}" role="checkbox"
           aria-checked="${on}" tabindex="0">
          <span class="dot" style="background:${_WCOL[b]}"></span>${b}
          <span class="cnt">${counts[b]}</span></div>`;
      }).join("")}
    </div>
    <p class="filterbar-note">Wards outside the selection stay on the map, dimmed.${
      nodata?` ${nodata} ward${nodata>1?"s":""} have no reading and stay grey.`:""}</p>`;

  fb.querySelector("#filterClose").onclick=()=>{
    fb.classList.add("hidden");
    $("#filterToggle").setAttribute("aria-expanded","false");
  };
  const all=fb.querySelector(".fchip-all");
  const setAll=()=>{st.filterBands=new Set(_WBAND);renderFilterBar();applyFilterDim();};
  all.onclick=setAll;
  all.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setAll();}};

  fb.querySelectorAll(".fchip[data-b]").forEach(ch=>{
    const toggle=()=>{
      const b=ch.dataset.b;
      if(st.filterBands.has(b))st.filterBands.delete(b);else st.filterBands.add(b);
      if(!st.filterBands.size)st.filterBands=new Set(_WBAND);  /* never show nothing */
      renderFilterBar();applyFilterDim();
    };
    ch.onclick=toggle;
    ch.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();toggle();}};
  });
}
function wireFilterDrag(){
  const fb=$("#filterbar");if(!fb)return;
  let dragging=false,ox=0,oy=0;
  fb.addEventListener("mousedown",e=>{
    if(!e.target.closest(".filterbar-grip"))return;
    const r=fb.getBoundingClientRect();
    fb.style.position="fixed";fb.style.left=r.left+"px";fb.style.top=r.top+"px";
    fb.style.right="auto";fb.style.bottom="auto";
    ox=e.clientX-r.left;oy=e.clientY-r.top;dragging=true;e.preventDefault();
  });
  document.addEventListener("mousemove",e=>{
    if(!dragging)return;
    fb.style.left=Math.max(4,Math.min(window.innerWidth-48,e.clientX-ox))+"px";
    fb.style.top=Math.max(4,Math.min(window.innerHeight-48,e.clientY-oy))+"px";
  });
  document.addEventListener("mouseup",()=>{dragging=false;});
}
function applyFilterDim(){
  if(!st.geo||!st.map.getSource("wards"))return;
  st.geo.forEach((f,i)=>{
    const p=f.properties;
    /* A ward with no reading is not "filtered out" — it keeps its own grey
       treatment so a data gap stays visible rather than fading to nothing. */
    const dim=!!p.available&&!st.filterBands.has(p.band);
    st.map.setFeatureState({source:"wards",id:i},{dim});
  });
}

/* ── Layer switching: fill, legend, cursor readout and labels move together ── */
function setLayer(l,silent){
  if(!LAYERS[l])return;
  st.layer=l;
  $$("#layers button").forEach(b=>{
    const on=b.dataset.l===l;
    b.classList.toggle("on",on);b.setAttribute("aria-pressed",String(on));
  });
  if(!silent&&st.map.getLayer("ward-fills")){
    st.map.setPaintProperty("ward-fills","fill-color",buildFillColor(false));
    st.map.setPaintProperty("ward-3d","fill-extrusion-color",buildFillColor(true));
    st.map.setPaintProperty("ward-3d","fill-extrusion-height",buildExtrusionHeight());
  }
  renderLegend();
}

function renderLegend(){
  const lg=$("#legend");if(!lg)return;
  if(st.view==="india"){
    lg.innerHTML=`
      <div class="legend-title">Pilot coverage</div>
      <div class="legend-row">
        <span class="cell"><span class="sw" style="background:#4A86C8"></span>Ward-level modelling</span>
        <span class="cell"><span class="sw nodata"></span>No ward data</span>
      </div>
      <p class="hint-text">Four cities are modelled ward by ward. The rest of the map is basemap only.</p>`;
    return;
  }
  const L=LAYERS[st.layer]||LAYERS.htsi;
  const head=`<div class="legend-title">${esc(L.name)}<span class="legend-unit">${esc(L.unit)}</span></div>`;
  const raised=st.is3D?`<p class="hint-text">Raised view: ward height follows the risk band. It is not elevation.</p>`:"";

  if(L.kind==="ramp"){
    const stops=st.layer==="utci"?RAMP_UTCI:RAMP_VEG;
    const ticks=stops.map(([v])=>st.layer==="veg"?v+"%":String(v));
    ticks[ticks.length-1]+="+";
    lg.innerHTML=head+`
      <div class="legend-ramp">
        <div class="legend-ramp-bar" style="background:${rampCSS(stops)}"></div>
        <div class="legend-ramp-ticks">${ticks.map(t=>`<span>${t}</span>`).join("")}</div>
      </div>
      <div class="legend-row"><span class="cell"><span class="sw nodata"></span>No reading</span></div>
      <p class="hint-text">${esc(L.note)}</p>`+raised;
    return;
  }
  lg.innerHTML=head+`
    <div class="legend-row">
      ${_WBAND.map(k=>`<span class="cell"><span class="sw" style="background:${BCOL[k]}"></span>${k}</span>`).join("")}
      <span class="cell"><span class="sw nodata"></span>No reading</span>
    </div>
    <p class="hint-text">${esc(L.note)}</p>`+raised;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CITY PANEL
   ═══════════════════════════════════════════════════════════════════════════ */
function cityWorstBand(agg){
  if(!agg||!agg.distribution)return null;
  const dist=agg.distribution.mortality||{};
  for(const b of["Severe","High","Moderate","Low"])if(dist[b])return b;
  return null;
}
function renderSideCity(){
  const c=cityInfo(st.city);if(!c)return;
  const worst=cityWorstBand(st.agg);
  const popM=(c.census2011&&c.census2011.population)?(c.census2011.population/1e6).toFixed(1)+" M":"—";
  const glance=`<div class="glance">
      ${worst?`<span class="badge bg${worst}">${worst}</span>`:""}
      <div class="gtxt">${worst?`Worst ward band today is <b>${worst}</b>. `:""}<b>${c.n_wards}</b> wards,
      city population <b>${popM}</b> (Census 2011).</div></div>`;

  $("#sidepanel").innerHTML=`
    <div class="ov-head"><h2>${esc(c.name)}</h2>
      <p>${esc(c.state||"")}</p></div>
    ${glance}
    <div class="wtabs" role="tablist">
      <button class="wtab on" data-t="ov" type="button">Overview</button>
      <button class="wtab" data-t="tr" type="button">30-day trend</button>
      <button class="wtab" data-t="fc" type="button">5-day outlook</button>
      <button class="wtab" data-t="ac" type="button">Actions</button>
    </div>
    <div class="wtabpanel" data-p="ov">${cityHistCard(st.city)}${cityOverviewTab(st.agg)}
      <p class="prov" style="margin-top:10px">Switch layers above the map. Select any ward for its full profile.</p></div>
    <div class="wtabpanel hidden" data-p="tr"><div id="cityTrendSlot"></div></div>
    <div class="wtabpanel hidden" data-p="fc">${cityForecastTab(st.agg)}</div>
    <div class="wtabpanel hidden" data-p="ac">${cityActionsTab(st.agg)}<div id="allocSlot"></div></div>
    <div class="ov-grid"><button class="btn-ghost" id="backToIndia" type="button">Back to India</button></div>`;
  $("#sidepanel").querySelector("#backToIndia").onclick=()=>goIndia();
  wireTabs($("#sidepanel"));
}
function cityOverviewTab(agg){
  if(!agg||!agg.distribution)return`<p class="prov">Loading the city summary…</p>`;
  const dist=agg.distribution.mortality||{};
  const total=Object.values(dist).reduce((a,b)=>a+b,0)||1;
  const H=104,labH=16,padTop=16,plotBottom=H-labH,plotH=plotBottom-padTop;
  const bars=_WBAND.map((k,i)=>{
    const v=dist[k]||0,f=v/total,x=14+i*70+8;
    const h=Math.max(3,f*plotH),top=plotBottom-h;
    const numY=Math.min(top-6,plotBottom-18);
    return `<rect x="${x}" y="${top}" width="46" height="${h}" rx="2" fill="${BCOL[k]}" opacity="0.88"><title>${k}: ${v} wards</title></rect>
      <text x="${x+23}" y="${numY}" text-anchor="middle" font-size="10.5" font-weight="600" fill="${BCOL[k]}">${v}</text>
      <text x="${x+23}" y="${H-4}" text-anchor="middle" font-size="9" fill="#6b7c94">${k}</text>`;
  }).join("");
  return `<div class="card"><h4>Wards by mortality-risk band</h4>
    <svg viewBox="0 0 300 ${H}" style="width:100%" role="img" aria-label="Distribution of wards across risk bands">${bars}</svg>
    <p class="prov">${total} wards resolved from live weather and satellite inputs.</p>
    ${seasonNote(agg.season)}</div>`;
}
function seasonNote(se){
  if(!se||!se.enabled||se.factor===undefined||se.factor>=0.999||!se.normal_tmax)return"";
  const mo=new Date(2000,(se.month||1)-1,1).toLocaleString("en",{month:"long"});
  return`<p class="prov">Seasonal adjustment: ${mo} normal maximum ${se.normal_tmax} °C,
    exposure weighted at ${Math.round(se.seasonal*100)}%.</p>`;
}
function cityForecastTab(agg){
  if(!agg||!agg.distribution)return`<p class="prov">Loading the outlook…</p>`;
  const outlook=(agg.outlook||[]).map(p=>({lab:shortDay(p.day),mort:p.mortality_prob,hosp:p.hosp_prob}));
  if(!outlook.length)return`<p class="prov">The five-day outlook is still being computed.</p>`;
  return`<div class="card"><h4>City-wide mean risk, next 5 days</h4>${outlookLine(outlook)}
    <p class="prov">Mean across all resolved wards. Individual wards diverge; open one to see its own forecast.</p></div>`;
}
function cityActionsTab(agg){
  if(!agg)return`<p class="prov">Loading recommended actions…</p>`;
  const items=(agg.admin_measures||[]);
  return`<div class="card"><h4>Recommended administrative response</h4>
    <p class="prov">Alert level <b class="c${esc(agg.alert_level||"")}">${esc(agg.alert_level||"—")}</b></p>
    <div class="meas"><ul>${items.map(m=>`<li>${esc(m)}</li>`).join("")||"<li>No escalated action required.</li>"}</ul></div></div>`;
}

/* ── 30-day trend ── */
let _trendCache=null,_trendCacheTs=0,_trendWarming=false;
async function warmTrendCache(){
  if(_trendWarming)return;_trendWarming=true;
  try{_trendCache=await api("/api/trend?days=30");_trendCacheTs=Date.now();}catch(e){}
}
async function cityTrendCard(city,attempt){
  attempt=attempt||0;
  const sp=$("#sidepanel");if(!sp)return;
  const slot=sp.querySelector("#cityTrendSlot");if(!slot)return;
  const name=cityName(city);
  const put=html=>{const s=$("#sidepanel");const el=s&&s.querySelector("#cityTrendSlot");if(el)el.innerHTML=html;};
  if(attempt===0)put(dcard("30-day heat trend",esc(name),"loading",`<p class="prov">Loading…</p>`,true));
  try{
    const now=Date.now();
    if(!_trendCache||now-_trendCacheTs>120000){_trendCache=await api("/api/trend?days=30");_trendCacheTs=now;}
    const key=String(city||"").trim().toLowerCase();
    const rows=(_trendCache.series||[])
      .map(p=>({p,c:(p.cities||[]).find(x=>String(x.city||"").trim().toLowerCase()===key)}))
      .filter(r=>r.c);
    if(!rows.length){
      if(attempt<40){_trendCache=null;setTimeout(()=>cityTrendCard(city,attempt+1),3000);return;}
      put(dcard("30-day heat trend",esc(name),"","<p class='prov'>No trend history has been recorded yet.</p>",true));
      return;
    }
    const HO={"Low":30,"Moderate":52,"High":74,"Severe":96};
    const bars=rows.map((r,i)=>{
      const p=r.p,b=r.c.worst||"Low",live=p.src==="live-scan";
      const dlabel=(p.ts||"").slice(8,10);
      const tip=(p.ts||"").slice(0,10)+" — "+name+": "+b+(live?" (live scan)":" (archive backfill)");
      return `<div class="trend-col" title="${esc(tip)}">
        <i style="height:${HO[b]||40}px;background:${_WCOL[b]||NODATA};${live?"":"opacity:.45"}"></i>
        <span>${(i%5===0)?dlabel:""}</span></div>`;
    }).join("");
    const last=rows[rows.length-1].c.worst||"Low";
    put(dcard("30-day heat trend",esc(name),"now "+last,`
      <div class="trend-strip">${bars}</div>
      ${bandKeyHTML()}
      <p class="prov">Solid bars are live scans. Faded bars are archive backfill.</p>`,true));
  }catch(e){
    if(attempt<40){setTimeout(()=>cityTrendCard(city,attempt+1),3000);return;}
    put(dcard("30-day heat trend",esc(name),"","<p class='prov'>Trend unavailable.</p>",true));
  }
}
async function allocationCard(city){
  try{
    const a=await api(`/api/city/${city}/allocation`);
    const rows=(a.rows||[]).filter(r=>r.priority_score>0).slice(0,6);
    const body=`<div class="t-scroll"><table class="t">
      <thead><tr><th>Ward</th><th>Mortality</th><th>Score</th><th>Share</th></tr></thead>
      <tbody>${rows.map(r=>`<tr><td>${esc(r.ward)}</td>
        <td><span class="badge bg${r.mort_band}">${r.mort_band}</span></td>
        <td class="num">${r.priority_score}</td>
        <td class="num">${r.share_pct}%</td></tr>`).join("")
        ||`<tr><td colspan="4">Every ward is Low risk. No prioritisation needed today.</td></tr>`}
      </tbody></table></div>
      <p class="prov">Share is a suggested split of a fixed response budget, derived from the priority score.</p>`;
    const sp=$("#sidepanel");const slot=sp&&sp.querySelector("#allocSlot");
    if(slot)slot.innerHTML=dcard("Resource allocation","highest-priority wards",rows.length+" flagged",body,true);
  }catch(e){
    const sp=$("#sidepanel");const slot=sp&&sp.querySelector("#allocSlot");
    if(slot)slot.innerHTML=`<p class="prov">Allocation ranking unavailable.</p>`;
  }
}
function bandKeyHTML(){
  return`<div class="band-key">${_WBAND.map(b=>
    `<span><i style="background:${_WCOL[b]}"></i>${b}</span>`).join("")}</div>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   WARD VIEW
   ═══════════════════════════════════════════════════════════════════════════ */
function selectWard(id){
  const idx=st._wardIdxMap[id];
  if(idx===undefined||!st.map.getSource("wards"))return;
  if(st._selectedIdx!==null&&st._selectedIdx!==idx)
    st.map.setFeatureState({source:"wards",id:st._selectedIdx},{selected:false});
  st._selectedWardId=id;st._selectedIdx=idx;
  st.map.setFeatureState({source:"wards",id:idx},{selected:true});
}
function deselectWard(){
  if(st._selectedIdx!==null&&st.map.getSource("wards"))
    st.map.setFeatureState({source:"wards",id:st._selectedIdx},{selected:false});
  st._selectedWardId=null;st._selectedIdx=null;
}
function backToCityMap(){
  deselectWard();
  if(st.geo&&st.geo.length){
    const bounds=new maplibregl.LngLatBounds();
    st.geo.forEach(f=>{const c=centroid(f.geometry);if(c)bounds.extend(c);});
    if(!bounds.isEmpty())st.map.fitBounds(bounds,{padding:48,duration:600});
  }
  closeSideQuiet();
  $("#sepCrumb2").classList.add("hidden");$("#crumbWard").classList.add("hidden");
  $("#crumbCity").classList.add("cur");
  status(cityName(st.city)+" — select a ward for its full profile.");
}

async function openWard(id){
  const city=st.city;
  status("Loading ward profile…","busy");
  const feat=(st.geo||[]).find(f=>f.properties.id===id);
  if(feat){
    const c=centroid(feat.geometry);
    if(c)st.map.flyTo({center:c,zoom:13.4,duration:700,pitch:st.is3D?52:0});
  }
  selectWard(id);
  let d;
  try{
    d=await api(`/api/city/${city}/ward/${id}`);
  }catch(e){
    status("Could not load that ward: "+e.message,"err");
    deselectWard();
    return;
  }
  if(st.city!==city)return;
  st.current=d;

  $("#sepCrumb2").classList.remove("hidden");$("#crumbWard").classList.remove("hidden");
  $("#crumbWard").textContent=d.ward.label;
  $("#crumbCity").classList.remove("cur");

  const sp=$("#sidepanel");
  sp.innerHTML=wardHTML(d);
  $("#side").classList.remove("hidden");
  wireTabs(sp);
  preventiveSimCard();

  status((d.snapshot&&d.snapshot.available)
    ? `${d.ward.label} — HTSI ${n3(d.snapshot.current.htsi)}, band ${d.snapshot.current.band}`
    : `${d.ward.label} — not enough data to model this ward`);
}

function wardHTML(d){
  const s=d.snapshot,w=d.ward;
  if(!s||!s.available){
    return`<div class="w-head"><div><h2>Ward ${esc(w.label)}</h2>
      <div class="w-sub">${esc(d.city_name||"")}</div></div>
      <span class="badge bgInsufficient">No reading</span></div>
      <p class="prov">This ward has no resolvable weather or satellite inputs right now, so no
      risk figure is shown. Nothing is estimated in its place.</p>`;
  }
  const c=s.current,env=s.environment.satellite,meas=s.measures;

  const calLine=m=>{
    const k=m.calibrated;
    if(!k)return`<div class="hline">${histChip("default","Default coefficients")}</div>`;
    return`<div class="hline">${histChip(k.basis,k.label)}
      <span class="hint"><b>${k.excess_pct>=0?"+":""}${k.excess_pct}%</b> versus normal, RR ${k.rr}${
      k.admissions_used?", admissions "+esc(k.admissions_date):""}</span></div>`;
  };
  const mk=(m,lab)=>`<div class="risk" style="border-left-color:${BCOL[m.band]}">
    <b>${lab}</b><span class="badge bg${m.band}">${esc(m.band)}</span>
    <span class="hint">${pct(m.probability)} above baseline</span></div>${calLine(m)}`;

  const R=48,CIRC=2*Math.PI*R;
  const gauge=`<svg class="gauge" viewBox="0 0 120 120" role="img"
      aria-label="HTSI ${n3(c.htsi)}, band ${esc(c.band)}">
    <circle cx="60" cy="60" r="${R}" fill="none" stroke="#eef2f7" stroke-width="9"/>
    <circle cx="60" cy="60" r="${R}" fill="none" stroke="${BCOL[c.band]}" stroke-width="9"
      stroke-linecap="round" stroke-dasharray="${CIRC.toFixed(1)}"
      stroke-dashoffset="${(CIRC*(1-Math.min(1,c.htsi/0.5))).toFixed(1)}"
      transform="rotate(-90 60 60)"/>
    <text x="60" y="56" text-anchor="middle" font-size="18" font-weight="600"
      class="gauge-val" fill="${BCOL[c.band]}">${n3(c.htsi)}</text>
    <text x="60" y="72" text-anchor="middle" font-size="9.5" fill="#6b7c94">HTSI</text></svg>`;

  const topAction=(meas.admin&&meas.admin[0])||(meas.user&&meas.user[0])||"No escalated action required.";
  const zone=w.zone?`Zone ${esc(w.zone)}`:"";
  const area=w.area_km2?`${w.area_km2} km²`:"";
  const sub=[zone,area].filter(Boolean).join(" · ");

  return`
  <div class="w-head">
    <div><h2>${esc(w.label)} <span class="w-city">${esc(d.city_name||"")}</span></h2>
      <div class="w-sub">${sub}</div></div>
    <div class="box2">${gauge}
      <div><div class="badge bg${c.band}">${esc(c.band)}</div>
        <div class="w-state${c.sim_active?" preview":""}">${c.sim_active?"PREVIEW":"live"}</div></div></div>
  </div>

  ${c.sim_active?`<div class="cav">A heatwave preview is active. Every figure below is modelled on
    raised temperatures, not observed conditions.</div>`:""}

  <div class="wact"><div class="wact-lab">Recommended action</div>
    <div class="wact-txt">${esc(topAction)}</div></div>

  <div class="card"><h4>Why this ward is at risk <span class="hint">four model factors</span></h4>
    ${factorBars(s)}</div>

  <div class="wtabs" role="tablist">
    <button class="wtab on" data-t="ov" type="button">Overview</button>
    <button class="wtab" data-t="fc" type="button">Forecast</button>
    <button class="wtab" data-t="gd" type="button">Guidance</button>
    <button class="wtab" data-t="dt" type="button">Data</button>
  </div>

  <div class="wtabpanel" data-p="ov">
    <div class="card"><h4>Mortality risk</h4>${s.mortality?mk(s.mortality,"Excess mortality"):`<p class="prov">Not modelled.</p>`}</div>
    <div class="card"><h4>Hospitalisation spike</h4>${s.hospitalisation?mk(s.hospitalisation,"Admissions surge"):`<p class="prov">Not modelled.</p>`}</div>
    ${mortChart(s)}
    ${readingsCard(c,d,env)}
  </div>

  <div class="wtabpanel hidden" data-p="fc">${wardTrendChart(s)}${forecastCard(s.forecast)}</div>

  <div class="wtabpanel hidden" data-p="gd">
    <div class="card"><h4>Response measures <span class="hint">level ${esc(meas.level)}</span></h4>
      <div class="meas"><h5>For the municipality</h5>
        <ul>${(meas.admin||[]).map(m=>`<li>${esc(m)}</li>`).join("")}</ul></div>
      <div class="meas"><h5>For residents — English, Hindi and ${esc((meas.user_i18n||{}).state_lang_name||"state language")}</h5>
        <ul>${(meas.user||[]).map((m,i)=>{
          const u=meas.user_i18n||{};
          return`<li><div>${esc(m)}</div>${u.hi?
            `<div class="lang">${esc(u.hi[i]||"")}</div>
             <div class="lang">${esc((u.state||[])[i]||"")}</div>`:""}</li>`;
        }).join("")}</ul>
        ${meas.emergency?`<div class="emergency">
          <div class="emergency-t">Heat stroke — call ${esc((meas.emergency.numbers||["112","108"]).join(" or "))}</div>
          <div>${esc(meas.emergency.en.signs)} ${esc(meas.emergency.en.call)}</div>
          <div class="lang">${esc(meas.emergency.hi.signs)} ${esc(meas.emergency.hi.call)}</div>
          <div class="lang">${esc(meas.emergency.state.signs)} ${esc(meas.emergency.state.call)}</div></div>`:""}
      </div></div>
    <div id="simAnchor"></div>
  </div>

  <div class="wtabpanel hidden" data-p="dt">
    <div class="card"><h4>Ward environment <span class="hint">satellite</span></h4>${satBars(env)}</div>
    <div class="card"><h4>City context</h4>
      <table class="t"><tbody>
        <tr><td>Population, Census 2011</td><td class="num">${
          (d.census2011&&d.census2011.population)?d.census2011.population.toLocaleString("en-IN"):"—"}</td></tr>
        <tr><td>Cooling access proxy</td><td class="num">${pct(s.environment.ac_ward)}</td></tr>
        <tr><td>Seasonal threshold</td><td class="num">${deg(c.baseline_90)}</td></tr>
      </tbody></table>
      <p class="prov">Population is a city total, not a ward count.</p></div>
    ${calCard(d.city)}
    <div class="sec">Input provenance</div>
    <table class="t"><tbody>
      <tr><td>Weather</td><td class="num">${deg(c.tair)}</td>
        <td><span class="tag ${s.layers.weather.provenance==="live"?"live":"ref"}">${esc(s.layers.weather.provenance)}</span></td></tr>
      <tr><td>Satellite environment</td><td class="num">${env.veg!=null?Math.round(env.veg*100)+"% veg":"—"}</td>
        <td><span class="tag sat">satellite</span></td></tr>
      <tr><td>Seasonal baseline</td><td class="num">${deg(c.baseline_90)}</td>
        <td><span class="tag ref">climatology</span></td></tr>
      <tr><td>Ward boundary</td><td class="num">${w.area_km2?w.area_km2+" km²":"—"}</td>
        <td><span class="tag">municipal GIS</span></td></tr>
    </tbody></table>
    <p class="prov" style="margin-top:8px">${esc(s.layers.weather.cadence||"")}</p>
  </div>`;
}

/* Additional readings. Humidity and wind are city-wide hourly scalars that
   feed the UTCI figure; they are labelled as such and never mapped. */
function readingsCard(c,d,env){
  const rows=[
    ["UTCI",c.utci!=null?n1(c.utci)+" °C":"—"],
    ["Air temperature",c.tair!=null?n1(c.tair)+" °C":"—"],
    ["Day maximum",c.daymax!=null?n1(c.daymax)+" °C":"—"],
    ["Versus seasonal P90",c.anom!=null?(c.anom>=0?"+":"")+n1(c.anom)+" °C":"—"],
    ["Humidity",c.rh!=null?Math.round(c.rh)+"%":"—"],
    ["Wind",c.wind_kmh!=null?n1(c.wind_kmh)+" km/h":"—"]
  ];
  const haveWx=c.rh!=null||c.wind_kmh!=null;
  return `<details class="dcard"><summary><h4>Additional readings</h4>
      <span class="dcard-teaser">${c.utci!=null?n1(c.utci)+" °C UTCI":"—"}</span></summary>
    <div class="dcard-body"><div class="kpis">
      ${rows.map(([k,v])=>kpi(k,v)).join("")}</div>
      <p class="prov">UTCI combines air temperature, humidity, wind speed and solar radiation.${
        haveWx?" Humidity and wind are city-wide hourly readings from the weather provider, not per-ward values."
              :" Humidity and wind are not reported by this API build."}</p>
    </div></details>`;
}

/* ── Shared components ── */
function wireTabs(scopeEl){
  scopeEl.querySelectorAll(".wtab").forEach(btn=>btn.onclick=()=>{
    scopeEl.querySelectorAll(".wtab").forEach(b=>b.classList.toggle("on",b===btn));
    const t=btn.dataset.t;
    scopeEl.querySelectorAll(".wtabpanel").forEach(p=>p.classList.toggle("hidden",p.dataset.p!==t));
  });
}
function kpi(k,v){return`<div class="kpi"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;}
function dcard(title,hint,teaser,bodyHtml,open){
  return`<details class="dcard"${open?" open":""}><summary>
    <h4>${title}${hint?` <span class="hint">${hint}</span>`:""}</h4>
    ${teaser?`<span class="dcard-teaser">${teaser}</span>`:""}</summary>
    <div class="dcard-body">${bodyHtml}</div></details>`;
}
function factorBars(s){
  if(!s||!s.factors)return`<p class="prov">Factor breakdown unavailable.</p>`;
  const f=s.factors;
  const row=(lab,v,col,src)=>`<div class="fbarrow">
    <span class="fblab" title="${esc(src)}">${lab}</span>
    <div class="bar"><i style="width:${Math.round(Math.min(1,Math.max(0,v))*100)}%;background:${col}"></i></div>
    <span class="fbval">${v.toFixed(2)}</span></div>`;
  return`<div class="factorbars">
    ${row("Hazard",f.H,BCOL.Severe,"ERA5 temperature anomaly and UTCI")}
    ${row("Vulnerability",f.V,BCOL.Moderate,"Census 2011 ward demographics")}
    ${row("Exposure",f.E,BCOL.High,"Satellite land cover and MODIS land-surface temperature")}
    ${row("Adaptive capacity",f.AC,BCOL.Low,"Per-ward cooling-access proxy")}
  </div>
  <p class="fmeta">Vulnerability index <b>${(f.v_index*100).toFixed(0)}</b>,
    model confidence <b>${pct(f.confidence)}</b>.${
    (f.v_pending&&f.v_pending.length)?` Awaiting data: ${esc(f.v_pending.join(", "))}.`:""}
    Higher adaptive capacity lowers the result.</p>`;
}

/* ── Charts ── */
function mortChart(s){
  const cur=s.mortality,fc=s.forecast||[];
  if(!cur)return"";
  const pts=[{lab:"Today",mort:cur.probability,hosp:s.hospitalisation?s.hospitalisation.probability:null}];
  fc.forEach(f=>pts.push({lab:shortDay(f.day),
    mort:f.mortality_prob!=null?f.mortality_prob:null,
    hosp:f.hosp_prob!=null?f.hosp_prob:null}));
  if(pts.filter(p=>p.mort!=null).length<2)return"";
  const W=300,H=150,padL=34,padB=26,padT=16,padR=10,iw=W-padL-padR,ih=H-padT-padB;
  const xp=i=>padL+(pts.length<=1?iw/2:iw*i/(pts.length-1));
  const max=Math.max(...pts.map(p=>Math.max(p.mort||0,p.hosp||0,0.01)),0.2)*1.1;
  const yp=v=>padT+ih-(v/max)*ih;
  const col=v=>v<0.06?BCOL.Low:v<0.22?BCOL.Moderate:v<0.45?BCOL.High:BCOL.Severe;
  const line=(key,stroke)=>{
    let dd="";pts.forEach((p,i)=>{const v=p[key];if(v==null)return;dd+=(dd?"L":"M")+xp(i).toFixed(1)+" "+yp(v).toFixed(1)+" ";});
    return dd?`<path d="${dd}" fill="none" stroke="${stroke}" stroke-width="2"/>`:"";
  };
  const dots=key=>pts.map((p,i)=>p[key]==null?"":
    `<circle cx="${xp(i).toFixed(1)}" cy="${yp(p[key]).toFixed(1)}" r="3" fill="${col(p[key])}" stroke="#ffffff" stroke-width="1"/>`).join("");
  const grid=Array.from({length:5},(_,k)=>
    `<line x1="${padL}" x2="${W-padR}" y1="${yp((max/5)*(k+1))}" y2="${yp((max/5)*(k+1))}" stroke="rgba(16,35,63,.06)"/>`).join("");
  const labs=pts.map((p,i)=>`<text x="${xp(i)}" y="${H-8}" text-anchor="middle" font-size="8.5" fill="#6b7c94">${esc(p.lab)}</text>`).join("");
  const vals=pts.map((p,i)=>p.mort==null?"":
    `<text x="${xp(i)}" y="${yp(p.mort)-6}" text-anchor="middle" font-size="8" font-weight="600" fill="${col(p.mort)}">${Math.round(p.mort*100)}</text>`).join("");
  return`<div class="card"><h4>Mortality and hospitalisation outlook <span class="hint">% above baseline</span></h4>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:150px" role="img"
      aria-label="Mortality and hospitalisation risk over the forecast window">
      ${grid}${line("hosp","#C77DAE")}${line("mort","#6AA3DF")}${dots("hosp")}${dots("mort")}${vals}${labs}</svg>
    <div class="band-key"><span><i style="background:#6AA3DF"></i>Mortality</span>
      <span><i style="background:#C77DAE"></i>Hospitalisation</span></div>
    <p class="prov">Today: <b class="c${esc(cur.band)}">${pct(cur.probability)}</b> above baseline, band ${esc(cur.band)}.</p></div>`;
}
function shortDay(day){const m=(day||"").match(/[A-Za-z]{3} \d{1,2} \w{3}/);return m?day.split(" ")[0]:day;}
function outlookLine(pts){
  const W=300,H=118,padL=8,padB=20,padT=16,padR=8,iw=W-padL-padR,ih=H-padT-padB;
  const xp=i=>padL+(pts.length<=1?iw/2:iw*i/(pts.length-1));
  const max=Math.max(...pts.map(p=>Math.max(p.mort,p.hosp,0.01)),0.1)*1.15;
  const yp=v=>padT+ih-(v/max)*ih;
  const mcol=v=>v<0.06?BCOL.Low:v<0.22?BCOL.Moderate:v<0.45?BCOL.High:BCOL.Severe;
  const line=(k,stroke)=>{
    let dd="";pts.forEach((p,i)=>{dd+=(dd?"L":"M")+xp(i).toFixed(1)+" "+yp(p[k]).toFixed(1)+" ";});
    return`<path d="${dd}" fill="none" stroke="${stroke}" stroke-width="2"/>`+
      pts.map((p,i)=>`<circle cx="${xp(i).toFixed(1)}" cy="${yp(p[k]).toFixed(1)}" r="3" fill="${mcol(p[k])}" stroke="#ffffff" stroke-width="1"/>`).join("");
  };
  const grid=Array.from({length:4},(_,k)=>
    `<line x1="${padL}" x2="${W-padR}" y1="${yp(max/4*(k+1))}" y2="${yp(max/4*(k+1))}" stroke="rgba(231,237,243,.06)"/>`).join("");
  const labs=pts.map((p,i)=>`<text x="${xp(i)}" y="${H-6}" text-anchor="middle" font-size="8" fill="#6b7c94">${esc(p.lab)}</text>`).join("");
  const vals=pts.map((p,i)=>`<text x="${xp(i)}" y="${yp(p.mort)-5}" text-anchor="middle" font-size="8" font-weight="600" fill="${mcol(p.mort)}">${Math.round(p.mort*100)}</text>`).join("");
  return`<svg viewBox="0 0 ${W} ${H}" style="width:100%" role="img" aria-label="City-wide five-day risk">
      ${grid}${line("hosp","#C77DAE")}${line("mort","#6AA3DF")}${vals}${labs}</svg>
    <div class="band-key"><span><i style="background:#6AA3DF"></i>Mortality</span>
      <span><i style="background:#C77DAE"></i>Hospitalisation</span></div>`;
}
function wardTrendChart(s){
  const fc=s.forecast||[];
  if(!fc.length)return`<div class="card"><h4>Five-day heat trend</h4>
    <p class="prov">No forecast window is available for this ward yet.</p></div>`;
  const HO={"Low":34,"Moderate":58,"High":82,"Severe":106};
  const bars=fc.map(f=>{
    const b=f.band||"Low",h=HO[b]||40;
    const conf=f.confidence!=null?Math.round(f.confidence*100):null;
    const tip=`${f.day}: ${b}, HTSI ${n3(f.peak_htsi)}, UTCI ${n1(f.peak_utci)} °C`+(conf!=null?`, confidence ${conf}%`:"");
    return`<div class="fc-col" title="${esc(tip)}">
      <span class="fc-val" style="color:${BCOL[b]}">${n3(f.peak_htsi)}</span>
      <i style="height:${h}px;background:${BCOL[b]};${conf!=null?`opacity:${Math.max(.5,conf/100)}`:""}"></i>
      <span class="fc-day">${esc((f.day||"").split(" ").slice(0,2).join(" "))}</span>
      <span class="badge bg${b}">${b}</span></div>`;
  }).join("");
  return`<div class="card"><h4>Five-day heat trend <span class="hint">peak HTSI per day</span></h4>
    <div class="fc-strip">${bars}</div>
    <p class="prov">Bar opacity follows forecast confidence, which degrades after day three.</p></div>`;
}

/* ── Forecast table ── */
const _sg=v=>(v>=0?"+":"")+v+"%";
function fcRR(f){
  const parts=[];
  if(f.mortality_excess_pct!=null)parts.push(`<div>Deaths <b>${_sg(f.mortality_excess_pct)}</b></div>`);
  if(f.hosp_excess_pct!=null)parts.push(`<div>Admissions <b>${_sg(f.hosp_excess_pct)}</b></div>`);
  return parts.length?parts.join(""):`<span class="hint">—</span>`;
}
function forecastCard(fc){
  if(!fc||!fc.length)return"";
  const worst=fc.reduce((a,f)=>(_WBAND.indexOf(f.band)>_WBAND.indexOf(a.band)?f:a),fc[0]);
  const body=`<div class="t-scroll"><table class="t">
    <thead><tr><th>Day</th><th>HTSI</th><th>UTCI</th><th>Band</th><th>Mortality</th>
      <th>Hospitalisation</th><th>Versus normal</th><th>Confidence</th></tr></thead>
    <tbody>${fc.map(f=>`<tr>
      <td>${esc(f.day)}</td>
      <td class="num">${n3(f.peak_htsi)}</td>
      <td class="num">${n1(f.peak_utci)}</td>
      <td><span class="badge bg${f.band}">${f.band}</span></td>
      <td>${f.mortality_prob!=null?`<span class="badge bg${f.peak_mortality_band}">${f.peak_mortality_band}</span>
        <span class="hint"> ${pct(f.mortality_prob)}</span>`:"—"}</td>
      <td>${f.hosp_prob!=null?`<span class="badge bg${f.peak_hosp_band}">${f.peak_hosp_band}</span>
        <span class="hint"> ${pct(f.hosp_prob)}</span>`:"—"}</td>
      <td>${fcRR(f)}</td>
      <td><span class="conf"><span class="bar"><i style="width:${((f.confidence||0)*100)|0}%;background:${
        (f.confidence||0)<0.62?BCOL.High:"#6AA3DF"}"></i></span></span><span class="num">${pct(f.confidence)}</span></td>
      </tr>`).join("")}</tbody></table></div>`;
  return dcard("Five-day forecast detail","confidence degrades after day three",
    `worst ${worst.day}`,body,true);
}

/* ── Satellite environment ── */
function satBars(env){
  const b=(lab,v,col,note)=>v==null?
    `<div class="satrow"><span>${lab}</span><b class="num">no data</b></div>`:
    `<div class="satrow"><span>${lab}${note?` <span class="hint">${note}</span>`:""}</span>
       <b class="num">${Math.round(v*100)}%</b></div>
     <div class="bar"><i style="width:${Math.min(100,v*100)|0}%;background:${col}"></i></div>`;
  let s=b("Vegetation",env.veg,BCOL.Low)+b("Built-up",env.built,BCOL.High)+b("Water",env.water,"#6AA3DF");
  if(env.ndvi_modis!=null)s+=b("NDVI",Math.max(0,env.ndvi_modis),"#2F7A3E","MODIS");
  if(env.lst_day_c!=null)s+=`<div class="satrow"><span>Land-surface temperature <span class="hint">MODIS daytime</span></span>
      <b class="num">${n1(env.lst_day_c)} °C</b></div>
    <div class="bar"><i style="width:${Math.min(100,Math.max(4,(env.lst_day_c-20)*6))|0}%;background:${BCOL.Severe}"></i></div>`;
  if(env.lcz!=null)s+=`<div class="satrow"><span>Local climate zone</span>
      <b class="num">LCZ ${esc(env.lcz)} ${esc(env.lcz_name||"")}</b></div>
    <div class="bar"><i style="width:${Math.max(4,Math.min(100,Math.round((env.lcz_built_share||0)*100)))}%;background:#9D86D8"></i></div>`;
  return s;
}

/* ── Calibration basis ── */
const CAL_META={"fitted":{cls:"fit",txt:"Fitted to local records"},
                "published-anchor":{cls:"pub",txt:"Anchored to published study"},
                "default":{cls:"none",txt:"Default coefficients"}};
function histChip(basis,title){
  const m=CAL_META[basis]||CAL_META["default"];
  return`<span class="hchip ${m.cls}" title="${esc(title||"")}">${m.txt}</span>`;
}
function calDetail(b){
  if(!b||b.basis==="default")
    return`<p class="hint">${esc((b&&b.note)||"No local health records are loaded, so published default coefficients are used.")}</p>`;
  if(b.basis==="fitted"){
    const p=b.period||[];
    return`<p class="hint">Fitted to ${b.n_days} daily records from ${esc(p[0])} to ${esc(p[1])}. Slope ${b.beta_a} ± ${b.se_a}.</p>`;
  }
  const ci=b.rr_ci?` (95% CI ${b.rr_ci[0]}–${b.rr_ci[1]})`:"";
  return`<p class="hint">Published relative risk ${b.rr_ref}${ci}. ${esc(b.source||"")}</p>`+
    (b.caveat?`<div class="cav">${esc(b.caveat)}</div>`:"");
}
function calCard(city){
  const c=st.cal&&st.cal.cities&&st.cal.cities[city];
  if(!c)return"";
  const m=c.mort||{},h=c.hosp||{},o=c.observed_rows||{deaths:0,admissions:0};
  const base=m.baseline_per_day!=null?
    `<tr><td>Typical deaths per day</td><td class="num">${m.baseline_per_day}</td></tr>
     <tr><td colspan="2" class="hint">${esc(m.baseline_note||"")}</td></tr>`:"";
  return`<div class="card"><h4>Historical calibration</h4>
    <div class="hrow"><span>Mortality</span>${histChip(m.basis,m.source||m.note||"")}</div>${calDetail(m)}
    <div class="hrow"><span>Hospitalisation</span>${histChip(h.basis,h.note||"")}</div>${calDetail(h)}
    <table class="t"><tbody>
      <tr><td>Local records loaded</td><td class="num">${o.deaths} days of deaths, ${o.admissions} days of admissions</td></tr>
      ${base}</tbody></table>
    <p class="hint">Calibration is set at city level. Differences between wards come from the
      modelled vulnerability, exposure and adaptive-capacity factors, not from local health data.</p></div>`;
}
function cityHistCard(city){
  const c=st.cal&&st.cal.cities&&st.cal.cities[city];
  if(!c)return"";
  const m=c.mort||{},h=c.hosp||{},o=c.observed_rows||{deaths:0,admissions:0};
  const none=!(o.deaths||o.admissions);
  const note=(none?"No local health records are loaded for this city."
    :`${o.deaths} days of death records and ${o.admissions} days of admissions are loaded.`)
    +(m.basis==="published-anchor"?" Mortality is anchored to a published study rather than local data.":"");
  return`<div class="card"><h4>Historical health data</h4>
    <div class="hrow"><span>Mortality</span>${histChip(m.basis,m.source||m.note||"")}</div>
    <div class="hrow"><span>Hospitalisation</span>${histChip(h.basis,h.note||"")}</div>
    <p class="hint">${note}</p></div>`;
}

/* ── Preventive-measures simulator ── */
const PS_LABELS={cooling_centres:"Cooling centres",water_audits:"Water audits",
  outdoor_work_reschedule:"Reschedule outdoor work",welfare_checks:"Welfare checks",
  grid_energy_notice:"Grid and energy notice"};
async function preventiveSimCard(){
  const d=st.current;
  if(!d||!d.ward||!$("#sidepanel"))return;
  let w;try{w=await api("/api/weights");}catch(e){return;}
  const keys=Object.keys(w.measure_effects||{});
  if(!keys.length)return;
  const sp=$("#sidepanel"),an=sp.querySelector("#simAnchor");
  if(!an)return;
  an.innerHTML=dcard("Preventive-measures simulator","scenario, not a forecast",keys.length+" measures",`
    <p class="prov">Select the measures a municipality could deploy in this ward, then apply them.
      The model re-runs with a raised adaptive-capacity assumption and shows the change. The result
      is a scenario, not an observation or a prediction.</p>
    <div class="ps-list">${keys.map(k=>
      `<label class="ps-opt"><input type="checkbox" data-m="${esc(k)}"> ${esc(PS_LABELS[k]||k)}</label>`).join("")}</div>
    <button class="btn-primary sm" id="psApply" type="button">Apply measures</button>
    <div id="psRes"></div>`,false);

  an.querySelector("#psApply").onclick=async()=>{
    const res=an.querySelector("#psRes");
    const sel=[...an.querySelectorAll("input:checked")].map(i=>i.dataset.m);
    if(!sel.length){res.innerHTML=`<p class="prov">Select at least one measure.</p>`;return;}
    res.innerHTML=`<p class="prov">Computing…</p>`;
    try{
      const j=await api("/api/scenario/preventive",{method:"POST",
        body:JSON.stringify({city:st.city,ward_id:String(d.ward.id),measures:sel})});
      if(!j.available){res.innerHTML=`<div class="cav">${esc(j.reason||"Not enough data for this ward.")}</div>`;return;}
      const row=(lab,m,h)=>`<div class="ps-row">
        <div class="ps-lab"><span>${esc(lab)}</span>
          <b class="num">${(m*100).toFixed(1)}% mortality, ${(h*100).toFixed(1)}% spike</b></div>
        <div class="ps-bars"><span class="bar"><i style="width:${Math.min(100,m*100)}%;background:#6AA3DF"></i></span>
          <span class="bar"><i style="width:${Math.min(100,h*100)}%;background:#C77DAE"></i></span></div></div>`;
      res.innerHTML=row("Baseline",j.baseline.mortality,j.baseline.hospitalisation)
        +(j.waterfall||[]).map(s=>row("with "+(PS_LABELS[s.measure]||s.measure),s.mort_after,s.hosp_after)).join("")
        +`<p class="prov">With all selected measures: mortality <b>${(j.adjusted.mortality*100).toFixed(1)}%</b>
          (${esc(j.adjusted.mort_band)}), hospitalisation <b>${(j.adjusted.hospitalisation*100).toFixed(1)}%</b>
          (${esc(j.adjusted.hosp_band)}).</p>`;
    }catch(e){res.innerHTML=`<div class="cav">Could not run the scenario: ${esc(e.message)}</div>`;}
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   HEATWAVE PREVIEW
   ═══════════════════════════════════════════════════════════════════════════ */
function toggleSimPop(force){
  const pop=$("#simPop");
  const open=force===undefined?pop.classList.contains("hidden"):force;
  pop.classList.toggle("hidden",!open);
  $("#simToggle").setAttribute("aria-expanded",String(open));
}
async function applySim(){
  const off=parseInt($("#simRange").value,10)||0;
  const btn=$("#simApply");btn.disabled=true;
  try{
    await api("/api/sim",{method:"POST",body:JSON.stringify({offset:off})});
    st.simOffset=off;
    updateSimBadge(off);
    if(st.city){
      await loadWards(false);
      if(st._selectedWardId!=null)await openWard(st._selectedWardId);
    }
  }catch(e){
    status("Preview failed: "+e.message,"err");
  }finally{btn.disabled=false;}
}
function updateSimBadge(off){
  const b=$("#simBadge"),strip=$("#simbar"),hint=$("#simHint");
  if(off>0){
    b.textContent="PREVIEW +"+off+" °C";b.className="sim-badge preview";
    strip.classList.add("previewing");
    hint.textContent="Every figure on screen is modelled on raised temperatures.";
    $("#simReset").classList.remove("hidden");
  }else{
    b.textContent="LIVE";b.className="sim-badge live";
    strip.classList.remove("previewing");
    hint.textContent="Showing current conditions.";
    $("#simReset").classList.add("hidden");
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   PANEL AND MODAL PLUMBING
   ═══════════════════════════════════════════════════════════════════════════ */
function toggleOverview(){
  const side=$("#side");
  if(!side.classList.contains("hidden")&&!st._selectedWardId){closeSide();return;}
  st._selectedWardId=null;st._selectedIdx=null;
  deselectWard();
  $("#sepCrumb2").classList.add("hidden");$("#crumbWard").classList.add("hidden");
  if(st.view==="city")$("#crumbCity").classList.add("cur");
  side.classList.remove("hidden");
  if(st.view==="city"){renderSideCity();cityTrendCard(st.city);allocationCard(st.city);}
  else renderSideIndia();
}
function closeSide(){
  if(st._selectedWardId){backToCityMap();return;}
  $("#side").classList.add("hidden");
}
function closeSideQuiet(){$("#side").classList.add("hidden");}

function modal(html){$("#mbody").innerHTML=html;$("#modal").classList.remove("hidden");}
function closeModal(){$("#modal").classList.add("hidden");}

/* Illustrative messages. Rendered in a visibly different, dashed container and
   labelled, so an example can never be mistaken for a message that was sent. */
const _OUTBOX_EXAMPLES=[
  {city:"Ahmedabad",ward:"16 Shahibag",htsi:"0.420",utci:"41.2",lang:"Gujarati",local:"બપોરે 12-4 ઘરની અંદર રહો | દર કલાકે પાણી પીવો | વૃદ્ધ પડોશીઓની ખબર રાખો"},
  {city:"Mumbai",ward:"12 Byculla",htsi:"0.380",utci:"39.6",lang:"Marathi",local:"दुपारी 12-4 घरातच रहा | दर तासाला पाणी प्या | वृद्ध शेजाऱ्यांची विचारपूस करा"},
  {city:"Chennai",ward:"9 Royapuram",htsi:"0.450",utci:"42.0",lang:"Tamil",local:"மதியம் 12-4 வீட்டிற்குள் இருங்கள் | ஒவ்வொரு மணி நேரமும் தண்ணீர் குடியுங்கள் | முதியோர் அண்டை வீட்டாரை கவனியுங்கள்"},
  {city:"Hyderabad",ward:"21 Malakpet",htsi:"0.400",utci:"40.5",lang:"Telugu",local:"మధ్యాహ్నం 12-4 ఇంట్లోనే ఉండండి | ప్రతి గంటకు నీరు తాగండి | వృద్ధ పొరుగువారిని పరామర్శించండి"}
];
async function outboxHTML(){
  const r=await api("/api/outbox");
  const sent=r.length?`<div class="alert">${r.map(e=>`
    <div class="row ${esc(e.type)}">
      <div class="meta">${esc(ist(e.ts))} &nbsp; <b>${esc(e.type)}</b> &nbsp; ${esc(e.ward)} &nbsp; ${esc(e.band)}${
        e.sim_active?` &nbsp; <b>from a preview</b>`:""}</div>
      <pre>${esc(e.message)}</pre>
      ${e.personal?`<div class="lang">${esc((e.personal.hi||[])[0]||"")}<br>${esc((e.personal.state||[])[0]||"")}</div>`:""}
    </div>`).join("")}</div>`
    : `<p class="prov">No alerts have been recorded yet. Running a heatwave preview generates them.</p>`;

  const examples=_OUTBOX_EXAMPLES.map(ex=>`<div class="sample">
    <div class="sample-lab">Example message format — ${esc(ex.city)}, not a sent alert</div>
    <pre>[THERMALENS ALERT] ${esc(ex.city)} ${esc(ex.ward)} - Heat escalation: High. HTSI ${ex.htsi}, UTCI ${ex.utci}C.
-- Personal guidance --
EN: Stay indoors 12-4pm | Drink water every hour | Check elderly
HI: दोपहर 12-4 बजे घर के अंदर रहें | हर घंटे पानी पिएं
${esc(ex.lang)}: ${esc(ex.local)}
-- EMERGENCY (heatstroke) --
Call 112/108 now.</pre></div>`).join("");

  return`<h2>Alert log</h2>
    <p class="prov">Alerts are delivered over SMS and WhatsApp through Twilio. Everything the
      system has actually queued or sent is listed first.</p>
    <div class="sec">Recorded alerts</div>${sent}
    <div class="sec">Message format</div>
    <p class="prov">The four blocks below show the template per pilot city, including the local
      language. They are illustrative and were never sent.</p>${examples}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   START
   ═══════════════════════════════════════════════════════════════════════════ */
let _started=false;
function startApp(){
  if(_started)return;_started=true;
  boot().catch(e=>{console.error(e);status("Startup failed: "+e.message,"err");});
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",startApp);else startApp();