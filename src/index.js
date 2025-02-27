import '@babel/polyfill'
import adapter from "webrtc-adapter";
const pull = require('pull-stream')
const Catch = require('pull-catch')
const CombineLatest = require('pull-combine-latest')
const Pushable = require('pull-pushable')
const Notify = require('pull-notify')
const createNode = require('./create-node')

const isDemo = new URL(location.href).searchParams.get('demoMode');
let serviceId = new URL(location.href).searchParams.get('serviceId');



if(isDemo && !serviceId){
  let redirectURL = new URL(location.origin);
  redirectURL.searchParams.set("demoMode","true");
  redirectURL.searchParams.set("serviceId", "DEMO_"+parseInt(Math.random()* 100000));
  window.location.replace(redirectURL.toString());
}

/* UI Stream */
const onAirFormStream = Notify()
onAirFormStream(false);
/* Network Stream */
const networkReadyNotify = Notify()
networkReadyNotify(false);

/* watch network Ready Status */
const flowFormEle = document.getElementById('flowInfo');
pull(
  networkReadyNotify.listen(),
  pull.drain(networkStatus => {
    if (networkStatus) {
      flowFormEle.setAttribute('data-status', 'connected');
    } else {
      flowFormEle.setAttribute('data-status', 'connecting');
    }
  }),
);

/* a snapshot from the video element */
const getSnapshot = () => {
  let canvas = document.createElement("canvas");
  let video = document.getElementById("studio_video");
  canvas.width = video.videoWidth / 4;
  canvas.height = video.videoHeight / 4;
  let ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, canvas.width, canvas.height);
  let snapShot = canvas.toDataURL();
  return snapShot;
}

const onAirFormSubmit = e => {
  e.preventDefault()
  console.log('ready clicked')
  const titleDOM = document.getElementById('title')
  if (!titleDOM.value) {
    alert('please enter a title of stream')
  } else {
    onAirFormStream(true);
  }
}
pull(
  onAirFormStream.listen(),
  pull.drain(o => {
    const titleDOM = document.getElementById('title');
    o && titleDOM.setAttribute('disabled', true) || titleDOM.removeAttribute('disabled')
  })
);

const domReady = () => {
  console.log('DOM ready')
  document.getElementById('onAirForm').addEventListener('submit', onAirFormSubmit)
}

let profile = {}
const getProfile = () => JSON.parse(localStorage.getItem('profile'))
const gotoStudio = () => {
  document.body.setAttribute('data-scene', 'studio')
  document.getElementById('streamerId').textContent = profile.nickName
}

const initSetup = () => {
  if (!localStorage.getItem('profile')) {
    document.body.setAttribute('data-scene', 'setup')
    const avatarElements = document.getElementsByClassName('avatar')
    const randomAvatarId = `${~~(Math.random() * 52)}`.padStart(2, '0')
    console.log(randomAvatarId)
    const setAvatarId = id =>
      Array.from(avatarElements).forEach(o => o.setAttribute('data-id', id))
    setAvatarId(randomAvatarId)
    document.querySelectorAll('.card>.thumbnails>dd')
      .forEach(o => o.addEventListener('click', e => {
        setAvatarId(e.currentTarget.getAttribute('data-id'))
    }))
    document.getElementById('userInfoForm').addEventListener('submit', async e => {
      e.preventDefault();
      const nickName = document.getElementById('nickName').value
      if (document.getElementById('nickName').value) {
        const {body} = await fetch(
          getComputedStyle(
            document.getElementsByClassName('avatar')[0]).backgroundImage.replace(/url\("(.*)"\)/g,
            '$1'),
        )
        const response = await new Response(body)
        const blob = await response.blob()
        const dataURI = await new Promise((resolve, reject) => {
          const r = new FileReader()
          r.onload = e => resolve(e.target.result)
          r.readAsDataURL(blob)
        })
        localStorage.setItem('profile', JSON.stringify({
          'avatar': {
            'image': dataURI.replace("application/octet-stream", "image/svg+xml"),
          },
          nickName,
        }))
        profile = getProfile()
        gotoStudio()
      }
      e.preventDefault()
    })
  } else {
    profile = getProfile()
    document.body.setAttribute('data-scene', 'studio')
    gotoStudio()
  }
}

const configuration = {
  iceServers: [{urls: 'stun:stun.l.google.com:19302'}]
};

let geoPosition ={};
const initApp = async () => {
  let geoPosition = await ((await fetch("https://extreme-ip-lookup.com/json/")).json());
  console.log('init app')
  initSetup()
  domReady()
  const node = await createNode()
  console.log('node created')
  console.log('node is ready', node.peerInfo.id.toB58String())

  let longitude = parseFloat(geoPosition.lon);
  let latitude = parseFloat(geoPosition.lat);

  geoPosition.coords = !isNaN(latitude) && !isNaN(longitude) && {longitude, latitude} || undefined;


  document.getElementById("myPeerId").textContent = `my Peer Id : ${node.peerInfo.id.toB58String()}`
  let connectedPrismPeerId = null;
  /* peerConnection */
  const options = {sdpSemantics: 'unified-plan'};

  const onHandle = option => (protocol, conn) => {
    let pc;
    let peerIdOfPrismOnHandle;
    let sendStream = Pushable();
    pull(sendStream,
      pull.map(o => JSON.stringify(o)),
      conn,
      pull.map(o => window.JSON.parse(o.toString())),
      pull.drain(o => {
        const controllerResponse = {
          "sendCreatedAnswer": async ({sdp}) => {
            console.log('controller answered', sdp)
            await pc.setRemoteDescription(sdp)
          },
          "sendTrickleCandidate": ({ice}) => {
            console.log("received iceCandidate", ice);
            pc.addIceCandidate(ice);
          },
          "requestStreamerInfo": ({peerId}) => {
            peerIdOfPrismOnHandle = peerId;
            if (connectedPrismPeerId) {
              sendStream.push({
                topic: "deniedStreamInfo",
              });
              //TODO: pull.end
              sendStream.end();
            } else { // isNull
              connectedPrismPeerId = peerId;
              let coords = geoPosition.coords ? {
                latitude: geoPosition.coords.latitude,
                longitude: geoPosition.coords.longitude,
              } : undefined;

              sendStream.push({
                topic: "setupStreamInfo",
                coords
              });
            }
          },
          'deniedSetupStreamInfo': () => {
            connectedPrismPeerId = null;
            //TODO: pull.end
            sendStream.end();
          },
          'readyToCast': () => {
            networkReadyNotify(true);
            console.log("connectedPrismPeerId : ", connectedPrismPeerId);
            document.getElementById("currentPrismPeerId").textContent = `currentPrismPeerId : ${connectedPrismPeerId}`
          },
          'updateWaves': ({waves})=>{
            document.getElementById("viewerCounts").textContent = Object.entries(waves).length;
          }

        };
        controllerResponse[o.topic] && controllerResponse[o.topic](o)
      }),
    )
    /* build a createOfferStream */
    pull(
      CombineLatest([onAirFormStream.listen(), networkReadyNotify.listen()]),
      pull.drain(async o => {
        console.log('combineLatest', o)
        if (o[1] && connectedPrismPeerId === peerIdOfPrismOnHandle) {
          try {
            pc = new RTCPeerConnection({...configuration, ...options});
            // send any ice candidates to the other peer
            pc.onicecandidate = event => {
              console.log('[ICE]', event)
              if (event.candidate) {
                sendStream.push({
                  topic: 'sendTrickleCandidate',
                  candidate: event.candidate,
                })
              }
            }
            pc.oniceconnectionstatechange = () => {
              console.log('[ICE STATUS] ', pc.iceConnectionState)
              if (pc.iceConnectionState === 'connected') {
                let updatedStreamerInfoData = {
                  topic: 'updateStreamerInfo',
                  profile: JSON.parse(localStorage.getItem('profile')),
                  title: document.getElementById('title').value,
                };

                sendStream.push(updatedStreamerInfoData);
                const sendScreenShot = () => {
                  let screenShot = getSnapshot();
                  if(screenShot === "data:,"){
                    setTimeout(sendScreenShot , 10000);
                  }else{
                    sendStream.push({
                      topic: "updateStreamerSnapshot",
                      snapshot: screenShot
                    })
                  }
                };
                setTimeout(sendScreenShot , 10000);
                document.getElementById('onAirLamp').setAttribute("onair",true);
                flowFormEle.setAttribute('data-status', 'streaming');
                document.getElementById('exit').addEventListener('click',e => window.location.reload());
                console.log("Set event");
              } else if(pc.iceConnectionState === 'completed'){
              } else if (pc.iceConnectionState === 'disconnected') {
                document.getElementById('onAirLamp').setAttribute("onair",false);
                pc.getTransceivers().forEach(transceiver => transceiver.direction = 'inactive');
                pc.close();
              } else if (pc.iceConnectionState === 'failed') {

              }
            }

            // let the "negotiationneeded" event trigger offer generation
            pc.onnegotiationneeded = () => {
            }
            // get a local stream, show it in a self-view and add it to be sent
            const studioVideo = document.getElementById('studio_video');
            if (!studioVideo.srcObject) {
              studioVideo.srcObject = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: true,
              });
            }
            studioVideo.srcObject.getTracks().forEach(track => pc.addTransceiver(track, {direction: 'sendonly'}));

            try {
              let offer = await pc.createOffer();
              const codecToFirst = (sdp, codec) => {
                const regCodecs = /a=rtpmap:(\d+) (.*)\//;
                const regVideos = /(m=video.*[A-Z\/]+ )([0-9 ]+)/;
                const h264ids = sdp.match(/a=rtpmap:(\d+) (.*)\//g)
                  .map(o => o.match(regCodecs).splice(1, 2))
                  .filter(o => o[1] === codec)
                  .map(o => o[0]);
                return sdp.replace(regVideos,
                  '$1' + sdp.match(regVideos)[2].split(' ')
                    .reduce((p, n) => h264ids.some(h => h === n) ? [n].concat(p) : p.concat(n), [])
                    .join(" ")
                );
              };
              // offer.sdp = codecToFirst(offer.sdp, "H264");
              await pc.setLocalDescription(offer);
              console.log('localDescription', pc.localDescription)
              sendStream.push({
                topic: 'sendCreatedOffer',
                sdp: pc.localDescription,
              })
            } catch (err) {
              console.error(err)
            }
          } catch (err) {
            console.error(err)
          }
        }
      }),
    )
  };
  node.handle(`/streamer/${serviceId}/unified-plan`, onHandle());
  // node.handle('/streamer', onHandle({}));
  node.on('peer:connect', peerInfo => {
    // console.log('peer connected:', peerInfo.id.toB58String())

  })
  node.on('peer:disconnect', peerInfo => {
    console.log('peer disconnected:', peerInfo.id.toB58String())
    if (peerInfo.id.toB58String() === connectedPrismPeerId) {
      networkReadyNotify(false);
      document.getElementById('onAirLamp').setAttribute("onair",false);
      connectedPrismPeerId = null;
    }
  })
  node.start(err => {
    if (err) {
      console.error(err)
      return
    }
    console.log(node.peerInfo.multiaddrs.toArray().map(o => o.toString()))
  })
}

initApp()
