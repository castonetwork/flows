import '@babel/polyfill'
import adapter from "webrtc-adapter";
const pull = require('pull-stream')
const Catch = require('pull-catch')
const CombineLatest = require('pull-combine-latest')
const Pushable = require('pull-pushable')
const Notify = require('pull-notify')
const createNode = require('./create-node')

/* UI Stream */
const onAirFormStream = Notify()//Pushable()

/* Network Stream */
const networkReadyNotify = Notify()

/* watch network Ready Status */
pull(
  networkReadyNotify.listen(),
  pull.filter(o => o),
  pull.drain(() => {
    document.getElementById('btnReady').classList.remove('connecting')
    document.getElementById('btnReady').classList.remove('button-outline')
  }),
)
pull(
  networkReadyNotify.listen(),
  pull.filter(o => !o),
  pull.drain(() => {
    document.getElementById('btnReady').classList.add('connecting')
    document.getElementById('btnReady').classList.add('button-outline')
  }),
)

/* a snapshot from the video element */
const getSnapshot = ()=>{
  let canvas = document.createElement("canvas");
  let video = document.getElementById("studio_video");
  canvas.width = video.offsetWidth / 4;
  canvas.height = video.offsetHeight / 4;
  let ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0,0, video.offsetWidth, video.offsetHeight, 0,0, canvas.width, canvas.height);
  return canvas.toDataURL();
}

const onAirFormSubmit = e => {
  e.preventDefault()
  console.log('ready clicked')
  const titleDOM = document.getElementById('title')
  if (!titleDOM.value) {
    alert('please enter a title of stream')
  } else {
    onAirFormStream(e);
    titleDOM.setAttribute('disabled', true)
  }
  
}

const domReady = () => {
  console.log('DOM ready')
  document.getElementById('onAirForm').
    addEventListener('submit', onAirFormSubmit)
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
    document.querySelectorAll('.card>.thumbnails>dd').
      forEach(o => o.addEventListener('click', e => {
        setAvatarId(e.currentTarget.getAttribute('data-id'))
      }))
    document.getElementById('userInfoForm').
      addEventListener('submit', async e => {
        e.preventDefault();
        const nickName = document.getElementById('nickName').value
        if (document.getElementById('nickName').value) {
          const {body} = await fetch(
            getComputedStyle(document.getElementsByClassName('avatar')[0]).
              backgroundImage.
              replace(/url\("(.*)"\)/g, '$1'),
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

const initApp = async () => {
  console.log('init app')
  initSetup()
  domReady()
  const node = await createNode()
  console.log('node created')
  console.log('node is ready', node.peerInfo.id.toB58String())
  document.getElementById("myPeerId").textContent = `my Peer Id : ${node.peerInfo.id.toB58String()}`
  let connectedPrismPeerId = null;
  const onHandle = option => (protocol, conn) => {
    const sendStream = Pushable()
    /* peerConnection */
    let pc = new RTCPeerConnection( { ...configuration, ...option } );
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
        sendStream.push({
          topic: 'updateStreamerInfo',
          profile: JSON.parse(localStorage.getItem('profile')),
          title: document.getElementById('title').value,
        })
        sendStream.push({
          topic: "updateStreamerSnapshot",
          snapshot: getSnapshot()
        })
      }
    }

    // let the "negotiationneeded" event trigger offer generation
    pc.onnegotiationneeded = () => {
    }

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
          "sendTrickleCandidate": ({ice})=> {
            console.log("received iceCandidate", ice);
            pc.addIceCandidate(ice);
          },
          "requestStreamerInfo": ({peerId}) => {
            if(connectedPrismPeerId){
              sendStream.push({
                topic: "deniedStreamInfo",
              });
              //TODO: pull.end
              sendStream.end();
            }else{// isNull
              connectedPrismPeerId = peerId;
              sendStream.push({
                topic: "setupStreamInfo",
              });
            }
          },
          'deniedSetupStreamInfo': ()=>{
            connectedPrismPeerId = null;
            //TODO: pull.end
            sendStream.end();
          },
          'readyToCast': ()=>{
            networkReadyNotify(true);
            console.log("connectedPrismPeerId : ", connectedPrismPeerId);
            document.getElementById("currentPrismPeerId").textContent = `currentPrismPeerId : ${connectedPrismPeerId}`
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
        if (o[1]) {
          try {
            // get a local stream, show it in a self-view and add it to be sent
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: true,
            });
            // stream.getTracks().forEach(track => pc.addTrack(track, stream))
            pc.addStream(stream);
            pc.getTransceivers().forEach(o => o.direction = 'sendonly')

            document.getElementById('studio_video').srcObject = stream
            try {
              await pc.setLocalDescription(await pc.createOffer())
              console.log('localDescription', pc.localDescription)
              sendStream.push({
                topic: 'sendCreateOffer',
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
  node.handle('/streamer/unified-plan', onHandle({sdpSemantics: 'unified-plan'}));
  node.handle('/streamer', onHandle({}));
  node.on('peer:connect', peerInfo => {
    // console.log('peer connected:', peerInfo.id.toB58String())

  })
  node.on('peer:disconnect', peerInfo => {
    console.log('peer disconnected:', peerInfo.id.toB58String())
    if (peerInfo.id.toB58String()===connectedPrismPeerId) {
      networkReadyNotify(false);
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
