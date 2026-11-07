#!/usr/bin/env python3
"""Apply the Linux-edition changes to the (pristine) UI bundle. Every patch must match exactly once (or the stated count)."""
import re,sys
if len(sys.argv)!=3: sys.exit('usage: patch_ui.py <pristine_dir containing index.js and main.js> <app_dir (resources/app)>')
SRC=sys.argv[1].rstrip('/')+'/'
DST=sys.argv[2].rstrip('/')+'/'
idx=open(SRC+'index.js',encoding='utf-8').read()
main=open(SRC+'main.js',encoding='utf-8').read()
log=[]
def sub(text,old,new,count=1,name=''):
    n=text.count(old)
    if n!=count: sys.exit(f'PATCH FAILED [{name}]: expected {count} match(es), found {n}')
    log.append(f'{name}: {n}'); return text.replace(old,new)

# ---- main process: no tray icon / tray menu
main=sub(main,'p=function(){if(void 0===u){','p=function(){return;if(void 0===u){',1,'no tray')

# ---- closing the window always exits the app (no hide-to-tray, no "ask" prompt)
idx=sub(idx,'this.appCloseState=void 0,','this.appCloseState="close",',1,'close state init')
idx=sub(idx,'a.setAppCloseState=function(e){this.appCloseState=e,void 0!==e?localStorage.setItem("appCloseState",JSON.stringify(e)):localStorage.removeItem("appCloseState")}','a.setAppCloseState=function(e){this.appCloseState="close"}',1,'close state setter')

# ---- remove the Share and My Account tabs (keyboard and mouse tab lists)
tabs='{title:Nx.text.社区共享(),page:(0,hx.jsx)(m2,{})},{title:Nx.text.个人中心(),page:(0,hx.jsx)(h2,{})},'
idx=sub(idx,tabs,'',2,'share/account tabs')

# ---- remove the Login/Register button in the title bar
idx=sub(idx,'$?(0,hx.jsx)("div",{}):null==k.currentUser?','!0?(0,hx.jsx)("div",{}):null==k.currentUser?',1,'login button')

# ---- updates: version checks become no-ops, upgrade pages can never open, buttons hidden
for fn in ['checkAppVersion','checkIotVersion','checkFwVersion','upgradeApp']:
    idx=sub(idx,f'a.{fn}=function(',f'a.{fn}=function(){{return Promise.resolve()}},a.__orig_{fn}=function(',1,'noop '+fn)
idx=sub(idx,'a.setDevUpgradePageShow=function(e){this.devUpgradePageShow=e}','a.setDevUpgradePageShow=function(e){this.devUpgradePageShow=!1}',1,'no fw page')
idx=sub(idx,'a.setAppUpgradePageShow=function(e){this.appUpgradePageShow=e}','a.setAppUpgradePageShow=function(e){this.appUpgradePageShow=!1}',1,'no app page')
idx=sub(idx,'(0,hx.jsx)(GG.Button,{w:75,h:25,mode:"Common",text:Nx.text.检查更新(),','(0,hx.jsx)("span",{hidden:!0,w:75,h:25,mode:"Common",text:Nx.text.检查更新(),',1,'hide check-update button')
idx=sub(idx,'(0,hx.jsx)(GG.Button,{w:75,h:25,style:{flex:"0 0 auto"},mode:"Common",text:Nx.text.固件升级(),','(0,hx.jsx)("span",{hidden:!0,w:75,h:25,style:{flex:"0 0 auto"},mode:"Common",text:Nx.text.固件升级(),',1,'hide fw-upgrade button')

# ---- remove the "Close" card on the About page (minimize-to-tray choice) - closing always exits
idx=sub(idx,'(0,hx.jsx)(FQ,{w:335,h:210,title:Nx.text.关闭(),style:{marginRight:50},children:(0,hx.jsxs)(GG.View,{style:{paddingTop:20},children:[(0,hx.jsx)(ZG,{style:{marginBottom:20},text:Nx.text.最小化到托盘不退出程序()','(0,hx.jsx)("span",{hidden:!0,children:(0,hx.jsxs)(GG.View,{style:{paddingTop:20},children:[(0,hx.jsx)(ZG,{style:{marginBottom:20},text:Nx.text.最小化到托盘不退出程序()',1,'hide close card')

# ---- Linux clean-ups
# "Start" card (start at login): Electron's login-item API does nothing on Linux, and with no tray a window popping up at login is not useful
idx=sub(idx,'(0,hx.jsx)(FQ,{w:300,h:210,title:Nx.text.启动(),children:','(0,hx.jsx)("span",{hidden:!0,children:',1,'hide start-at-login card')
# the About "Update" card now only shows versions
idx=sub(idx,'title:Nx.text.更新(),style:{marginRight:50}','title:Nx.text.更多(),style:{marginRight:50}',1,'rename update card')
# Windows process list / taskkill helper used at startup: not applicable (the driver runs inside the app)
idx=sub(idx,'N1=function(){if("darwin"!==process.platform)try{','N1=function(){return;if("darwin"!==process.platform)try{',1,'no tasklist/taskkill')
# OLED clock: the Windows "echo %date%" command returns garbage on Linux; use the POSIX date branch there
idx=sub(idx,'y="darwin"!==process.platform?qx().execSync("echo %date','y="win32"===process.platform?qx().execSync("echo %date',1,'oled clock via date')
# the Windows key is the Super key on Linux
idx=sub(idx,'ZG,{text:"Win",checkState:o("win")&&n','ZG,{text:"Super",checkState:o("win")&&n',1,'Win -> Super label')

# ---- NO ANALYTICS: Google Analytics 4 + two Universal Analytics trackers (sent machine id, OS version, page views)
idx=sub(idx,'a.event=function(e){var a=this;return new Promise((function(t){var y={client_id:a.clientID','a.event=function(e){return Promise.resolve(!1)},a.__orig_event=function(e){var a=this;return new Promise((function(t){var y={client_id:a.clientID',1,'GA4 sender disabled')
idx=sub(idx,'(0,IH.machineId)().then(','Promise.reject().then(',1,'no machine-id analytics init')
idx=sub(idx,'.trackPage=function(e){console.log("GGGAAAA",e);try{','.trackPage=function(e){return;try{',1,'no page tracking')
idx=sub(idx,'ZH.trackEvent=function(){var e=n()','ZH.trackEvent=function(){return Promise.resolve()},ZH.__orig_trackEvent=function(){var e=n()',1,'no event tracking')
idx=sub(idx,'ZH.trackScreen=function(e,a,t){_.app.isPackaged&&void 0!==KH&&','ZH.trackScreen=function(e,a,t){return;_.app.isPackaged&&void 0!==KH&&',1,'no screen tracking')

# ---- SCOPE: basic 6-button programmable keyboard (wired)
# Light tab: keep the basic lighting page, drop the animation editor, light strip and "My Work" library
idx=sub(idx,',{title:Nx.text.灯光编辑(),page:(0,hx.jsx)(OQ,{})},{title:Nx.text.灯带(),page:(0,hx.jsx)(CZ,{})},{title:Nx.text.我的作品(),page:(0,hx.jsx)(Sq,{})}]',']',1,'light: basic page only')
# Other Setting: wireless (2.4G / Bluetooth) sleep and backlight timers do not exist on a wired pad
idx=sub(idx,'company:"Firstblood",layout:Ma,layer:3,otherSetting:ve}','company:"Firstblood",layout:Ma,layer:3,otherSetting:{auto:ve.auto,deBounce:ve.deBounce}}',2,'B6: no wireless settings')
# Appearance card (custom background picture / colour / blur)
idx=sub(idx,'(0,hx.jsx)(FQ,{w:300,h:210,title:Nx.text.外观(),style:{marginRight:50},children:','(0,hx.jsx)("span",{hidden:!0,children:',1,'hide appearance card')

# ---- B6 key boxes aligned with the real device picture (measured from the picture: key centres x=350.5/435.5/520.5, y=99.5/184.5)
OLD_KEYS='{keyName:"copy",value:57350,x:335,y:-77,w:52,h:55},{keyName:"↑",value:82,x:416,y:-77,w:52,h:55},{keyName:"paste",value:57369,x:496,y:-77,w:52,h:55},{keyName:"←",value:80,x:335,y:-157,w:52,h:55},{keyName:"↓",value:81,x:416,y:-157,w:52,h:55},{keyName:"→",value:79,x:496,y:-157,w:52,h:55}'
NEW_KEYS='{keyName:"copy",value:57350,x:316,y:-65,w:70,h:70},{keyName:"↑",value:82,x:401,y:-65,w:70,h:70},{keyName:"paste",value:57369,x:486,y:-65,w:70,h:70},{keyName:"←",value:80,x:316,y:-150,w:70,h:70},{keyName:"↓",value:81,x:401,y:-150,w:70,h:70},{keyName:"→",value:79,x:486,y:-150,w:70,h:70}'
idx=sub(idx,OLD_KEYS,NEW_KEYS,1,'B6 key boxes aligned to the picture')

# ---- duplicate "Configuration" entries: the comparison used lodash isEqual on a freshly read config versus the stored (JSON round-tripped) one;
# isEqual({a:1,b:undefined},{a:1}) is false, so the stored copy never matched and a new identical entry was added. Normalise both sides first.
idx=sub(idx,'e.checkConfigValueEqual=function(e,a){var t,y,u,r,l=!0;','e.checkConfigValueEqual=function(e,a){e=JSON.parse(JSON.stringify(e)),a=JSON.parse(JSON.stringify(a));var t,y,u,r,l=!0;',1,'configuration compare ignores undefined fields')

open(DST+'dist/index.js','w',encoding='utf-8').write(idx)
open(DST+'main_dist/main.js','w',encoding='utf-8').write(main)
print('\n'.join(log)); print('all patches applied')
