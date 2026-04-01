/**
 * NOSTR_CLIENT_JS — browser-side NIP-01 WebSocket client.
 * Embed inline in page scripts: `${NOSTR_CLIENT_JS}`
 * Usage:
 *   nostrRelay.init('wss://relay.2020117.xyz')
 *   const sub = nostrRelay.subscribe([{kinds:[0],limit:50}], onEvent, onEose)
 *   const liveSub = nostrRelay.subscribe([{kinds:[30333],since:now-300}], onEvent, null, {live:true})
 *   sub.close()
 */
export const NOSTR_CLIENT_JS = `(function(){
var _ws,_url,_subs=new Map(),_cnt=0,_delay=1000;
function _conn(){
  _ws=new WebSocket(_url);
  _ws.onopen=function(){
    _delay=1000;
    _subs.forEach(function(e,id){
      _ws.send(JSON.stringify(['REQ',id].concat(e.filters)));
    });
  };
  _ws.onmessage=function(m){
    var msg;try{msg=JSON.parse(m.data);}catch{return;}
    if(!Array.isArray(msg))return;
    var s=_subs.get(msg[1]);
    if(msg[0]==='EVENT'&&s)s.onEvent&&s.onEvent(msg[2]);
    if(msg[0]==='EOSE'&&s){
      clearTimeout(s.timer);
      s.onEose&&s.onEose();
      if(!s.live){_subs.delete(msg[1]);if(_ws.readyState===1)_ws.send(JSON.stringify(['CLOSE',msg[1]]));}
    }
  };
  _ws.onclose=function(){setTimeout(_conn,_delay);_delay=Math.min(_delay*2,30000);};
  _ws.onerror=function(){};
}
window.nostrRelay={
  init:function(url){_url=url;_conn();},
  subscribe:function(filters,onEvent,onEose,opts){
    opts=opts||{};
    var id='r'+(++_cnt);
    var timer=opts.live?null:setTimeout(function(){
      var s=_subs.get(id);
      if(s){s.onEose&&s.onEose();_subs.delete(id);if(_ws&&_ws.readyState===1)_ws.send(JSON.stringify(['CLOSE',id]));}
    },opts.timeout||10000);
    _subs.set(id,{filters:filters,onEvent:onEvent,onEose:onEose,live:!!opts.live,timer:timer});
    if(_ws&&_ws.readyState===1)_ws.send(JSON.stringify(['REQ',id].concat(filters)));
    return{close:function(){clearTimeout(timer);_subs.delete(id);if(_ws&&_ws.readyState===1)_ws.send(JSON.stringify(['CLOSE',id]));}};
  }
};
})();`
