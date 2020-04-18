import Maximilian from './maximilian.wasmmodule.js';
import Open303 from './open303.wasmmodule.js';
// import {PostMsgTransducer} from './transducer.js'
// import {
//   MMLLOnsetDetector
// } from '../machineListening/MMLLOnsetDetector.js';

function vectorDoubleToF64Array(x) {
  let ar = new Float64Array(x.size());
  for(let i=0; i < ar.length; i++) {
    ar[i] = x.get(i);
  }
  return ar;
}

class OutputTransducer {
  constructor(port, sampleRate, sendFrequency = 2, transducerType) {
    if (sendFrequency == 0)
      this.sendPeriod = Number.MAX_SAFE_INTEGER;
    else
      this.sendPeriod = 1.0 / sendFrequency * sampleRate;
    this.sendCounter = this.sendPeriod;
    this.transducerType = transducerType;
    this.port=port;
  }

  send(data, channelID) {
    if (this.sendCounter >= this.sendPeriod) {
      console.log(data);
      this.port.postMessage({
        rq: "send",
        value: data,
        ttype: this.transducerType,
        ch: channelID
      });
      this.sendCounter -= this.sendPeriod;
    } else {
      this.sendCounter++;
    }
    return 0;
  }
}

class InputTransducer {
  constructor(transducerType, channelID) {
    this.transducerType = transducerType;
    this.channelID = channelID;
    this.value = 0;
  }

  setValue(data) {
    this.value = data;
    console.log(data);
  }

  getValue() {
    return this.value;
  }
}




class pvshift {
  constructor() {
    this.fft = new Maximilian.maxiFFT();
		this.fft.setup(1024,256,1024);
		this.ifft = new Maximilian.maxiIFFT();
		this.ifft.setup(1024,256,1024);
		this.mags = new Maximilian.VectorFloat();
		this.phases = new Maximilian.VectorFloat();
		this.mags.resize(512,0);
		this.phases.resize(512,0);
  }

  play(sig, shift) {
    if (this.fft.process(sig, Maximilian.maxiFFTModes.WITH_POLAR_CONVERSION)) {
      this.mags = this.fft.getMagnitudes();
      this.phases = this.fft.getPhases();
      //shift bins up
      for(let i=511; i > 0; i--) {
        if (i > shift) {
          this.mags.set(i, this.mags.get(i-shift));
          this.phases.set(i, this.phases.get(i-shift));
        }else{
          this.mags.set(i,0);
          this.phases.set(i,0);
        }
      }
      // console.log(mags.get(10));
    }
    sig = this.ifft.process(this.mags, this.phases, Maximilian.maxiIFFTModes.SPECTRUM);
    return sig;
  }
}





/**
 * The main Maxi Audio wrapper with a WASM-powered AudioWorkletProcessor.
 *
 * @class MaxiProcessor
 * @extends AudioWorkletProcessor
 */
class MaxiProcessor extends AudioWorkletProcessor {

  /**
   * @getter
   */
  static get parameterDescriptors() { // TODO: parameters are static? Can we not change this map with a setter?
    return [{
      name: 'gainSyn',
      defaultValue: 2.5
    }, {
      name: 'gainSeq',
      defaultValue: 6.5
    },
    {
      name: 'numClockPeers',
      defaultValue: 1
    }];
  }

  /**
   * @constructor
   */
  constructor() {
    super();

    let q1 = Maximilian.maxiBits.sig(63);
    // for(let i=0; i < 123; i++) q1 = Maximilian.maxiBits.inc(q1);
    // let q2 = Maximilian.maxiBits.sig(255);
    // let q3 = Maximilian.maxiBits.land(q1,q2);
    // let q4 = Maximilian.maxiBits.shl(q3, 22);
    // console.log("res: " + q1);

    this.sampleRate = 44100;

    this.DAC = [0];

    // this.onsetDetector = new MMLLOnsetDetector(this.sampleRate);

    this.tempo = 120.0; // tempo (in beats per minute);
    this.secondsPerBeat = (60.0 / this.tempo);
    this.counterTimeValue = (this.secondsPerBeat / 4); //___16th note

    // this.oldClock = 0;
    // this.phase = 0;

    this.numPeers = 1;

    this.newq = () => {return {"vars":{}}};
    this.newmem = () => {return new Float64Array(512)};
    this._q = [this.newq(),this.newq()];
    this._mems =[this.newmem(), this.newmem()];
    this._cleanup = [0,0];

    // this.setvar = (q, name, val) => {
    //   q.vars[name] = val;
    //   return val;
    // };
    //
    // this.getvar = (q, name) => {
    //   let val = q.vars[name];
    //   return val ? val : 0.0;
    // };

    this.silence = (q, inputs) => {
      return 0.0
    };
    this.signals = [this.silence, this.silence];
    this.currentSignalFunction = 0;
    this.xfadeControl = new Maximilian.maxiLine();

    // this.timer = new Date();

    this.OSCMessages = {};

    this.OSCTransducer = function(x, idx = 0) {
      let val = this.OSCMessages[x];
      return val ? idx >= 0 ? val[idx] : val : 0.0;
    };

    this.incoming = {};

    this.sampleBuffers={};
    this.sampleVectorBuffers = {};
    this.sampleVectorBuffers['defaultEmptyBuffer'] = new Float32Array(1);

    this.transducers = [];

    this.matchTransducers = (ttype, channel) => {
        return this.transducers.filter(x=>{
          let testEqChannels = (chID, channel) => {
            let eq = true;
            let keys = Object.keys(channel);
            if (keys.length==0) {
              eq = channel == chID;
            }else{
              for(let v in keys) {
                if(chID[v] != undefined) {
                  if (chID[v] != channel[v]) {
                    eq = false;
                    break;
                  }
                }else{
                  eq = false;
                  break;
                }
              }
            }
            return eq;
          }
          return x.transducerType==ttype && testEqChannels(x.channelID,channel);
        });
    }

    this.registerInputTransducer = (ttype, channelID) => {
      let transducer = new InputTransducer(ttype, channelID);
      let existingTransducers = this.matchTransducers(ttype, channelID);
      if (existingTransducers.length > 0) {
        transducer.setValue(existingTransducers[0].getValue());
      }
      this.transducers.push(transducer);
      // console.log(this.transducers);
      return transducer;
    };

    this.getSampleBuffer = (bufferName) => {
        let sample = this.sampleVectorBuffers['defaultEmptyBuffer']; //defailt - silence
        if (bufferName in this.sampleVectorBuffers) {
          sample = this.sampleVectorBuffers[bufferName];
        }else{
          console.warn(`${bufferName} doesn't exist yet`);
        }
        return sample;
    };

    this.netClock = new Maximilian.maxiAsyncKuramotoOscillator(3);  //TODO: this should be the same as numpeers
    this.kuraPhase = -1;
    this.kuraPhaseIdx = 1;

    let addSampleBuffer = (name, buf) => {
      this.sampleVectorBuffers[name] = this.translateFloat32ArrayToBuffer(buf);
    };

    this.codeSwapStates = {QUEUD:0, XFADING:1, NONE:2};
    this.codeSwapState = this.codeSwapStates.NONE;

    this.port.onmessage = event => { // message port async handler
      // console.log(event);
      if ('address' in event.data) {
        //this must be an OSC message
        this.OSCMessages[event.data.address] = event.data.args;
        //console.log(this.OSCMessages);
      } else if ('func' in event.data && 'sendbuf' == event.data.func) {
        console.log("aesendbuf", event.data);
        addSampleBuffer(event.data.name, event.data.data);
      } else if ('func' in event.data && 'data' == event.data.func) {
        //this is from the ML window, map it on to any listening transducers
        let targetTransducers = this.matchTransducers('ML', event.data.ch);
        for(let idx in targetTransducers) {
          targetTransducers[idx].setValue(event.data.val);
        }
      } else if ('peermsg' in event.data) {
        console.log('peer', event);
        //this is from peer streaming, map it on to any listening transducers
        let targetTransducers = this.matchTransducers('NET', [event.data.src, event.data.ch]);
        // console.log(targetTransducers.length);
        for(let idx in targetTransducers) {
          targetTransducers[idx].setValue(event.data.val);
        }
      } else if ('sample' in event.data) { //from a worker
        // console.log("sample received");
        // console.log(event.data);
        let sampleKey = event.data.sample.substr(0,event.data.sample.length - 4)
        // this.sampleBuffers[sampleKey] = event.data.buffer;
        addSampleBuffer(sampleKey, event.data.buffer);
        // this.sampleVectorBuffers[sampleKey] = this.translateFloat32ArrayToBuffer(event.data.buffer);
      }else if ('phase' in event.data) {
        // console.log(this.kuraPhaseIdx);
        // console.log(event);
        this.netClock.setPhase(event.data.phase, event.data.i);
        // this.kuraPhase = event.data.phase;
        // this.kuraPhaseIdx = event.data.i;
      } else if ('eval' in event.data) { // check if new code is being sent for evaluation?

        let setupFunction;
        let loopFunction;
        try {
          // console.log("[DEBUG]:MaxiProcessor:Process: ");
          // console.log(event.data);

          // let setupFunction = new Function(`return ${event.data['setup']}`);
          setupFunction = eval(event.data['setup']);
          loopFunction = eval(event.data['loop']);

          // let oldSignalFunction = this.currentSignalFunction;
          // this.currentSignalFunction = 1 - this.currentSignalFunction;
          // this._q[this.currentSignalFunction] = setupFunction();
          // //allow feedback between evals
          // this._mems[this.currentSignalFunction] = this._mems[oldSignalFunction];
          //
          // this.signals[this.currentSignalFunction] = loopFunction;
          // this._cleanup[this.currentSignalFunction] = 0;
          //
          // let xfadeBegin = Maximilian.maxiMap.linlin(1.0 - this.currentSignalFunction, 0, 1, -1, 1);
          // let xfadeEnd = Maximilian.maxiMap.linlin(this.currentSignalFunction, 0, 1, -1, 1);

          // let oldSignalFunction = this.currentSignalFunction;
          this.nextSignalFunction = 1 - this.currentSignalFunction;
          this._q[this.nextSignalFunction] = setupFunction();
          //allow feedback between evals
          this._mems[this.nextSignalFunction] = this._mems[this.currentSignalFunction];

<<<<<<< HEAD

         
         // output[SPECTROGAMCHANNEL][i] = specgramValue;
         // then use channelsplitter


          this.signals[this.currentSignalFunction] = loopFunction;
          this._cleanup[this.currentSignalFunction] = 0;
=======
          this.signals[this.nextSignalFunction] = loopFunction;
          this._cleanup[this.nextSignalFunction] = 0;
>>>>>>> env-persist-FIX

          let xfadeBegin = Maximilian.maxiMap.linlin(1.0 - this.nextSignalFunction, 0, 1, -1, 1);
          let xfadeEnd = Maximilian.maxiMap.linlin(this.nextSignalFunction, 0, 1, -1, 1);
          this.xfadeControl.prepare(xfadeBegin, xfadeEnd, 2, true); // short xfade across signals
          this.xfadeControl.triggerEnable(true); //enable the trigger straight away
          this.codeSwapState = this.codeSwapStates.QUEUD;
        } catch (err) {
          if (err instanceof TypeError) {
            console.log("TypeError in worklet evaluation: " + err.name + " – " + err.message);
          } else {
            console.log("Error in worklet evaluation: " + err.name + " – " + err.message);
            console.log(setupFunction);
            console.log(loopFunction);
          }
        }
      }
    };
    this.port.postMessage("giveMeSomeSamples");

    this.clockFreq = 0.7 / 4;
    this.clockPhaseSharingInterval=0; //counter for emiting clock phase over the network
    this.barFrequency = 4;
    this.setBarFrequency = (freq) => {this.barFrequency = freq; return 0;};

//@CLP
    this.clockPhase = (multiples, phase) => {
        return (((this.clockPhasor * multiples) % 1.0) + phase) % 1.0;
    };

//@CLT
    this.clockTrig = (multiples, phase) => {
        return (this.clockPhase(multiples, phase) - (1.0/this.sampleRate * multiples)) <= 0 ? 1 : 0;
    };
    this.setClockFreq = (freq) => {
      this.clockFreq = freq;
      return 0;
    };

    this.bitTime = Maximilian.maxiBits.sig(0);  //this needs to be decoupled from the audio engine? or not... maybe a 'permenant block' with each grammar?
    this.dt = 0;

    this.createMLOutputTransducer= (sendFrequency) => {
      return new OutputTransducer(this.port, this.sampleRate, sendFrequency, 'ML');
    }

    this.createNetOutputTransducer= (sendFrequency) => {
      return new OutputTransducer(this.port, this.sampleRate, sendFrequency, 'NET');
    }

    this.ifListThenToArray = (x) => {
      let val = x;
      // console.log(typeof(x));
      if (typeof(x) != 'number') {
        val = vectorDoubleToF64Array(x);
      }
      return val;
    }


  }

  /**
   * @process
   */
  process(inputs, outputs, parameters) {
    // this.port.postMessage("dspStart");


    // let ts = this.timer.getTime();

    // DEBUG:
    // console.log(`gain: ` + parameters.gain[0]);
    const outputsLength = outputs.length;

    for (let outputId = 0; outputId < outputsLength; ++outputId) {
      let output = outputs[outputId];
      let channelCount = output.length;

      for (let i = 0; i < output[0].length; ++i) {
        //this needs decoupling?
        this.bitTime = Maximilian.maxiBits.inc(this.bitTime);
        //net clocks
        // if (this.kuraPhase != -1) {
        //   // this.netClock.setPhase(this.kuraPhase, this.kuraPhaseIdx);
        //   console.log(this.kuraPhaseIdx);
        //testing
        // this.netClock.setPhase(this.netClock.getPhase(0), 1);
        // this.netClock.setPhase(this.netClock.getPhase(0), 2);
        //   this.kuraPhase = -1;
        // }
        this.netClock.play(this.clockFreq, 100);
        this.clockPhasor = this.netClock.getPhase(0) / (2 * Math.PI);
        //share the clock if networked
        // if (this.clockPhaseSharingInterval++ == 2000) {
        if (this.netClock.size() > 1 && this.clockPhaseSharingInterval++ == 2000) {
          this.clockPhaseSharingInterval=0;
          let phase = this.netClock.getPhase(0);
          // console.log(`DEBUG:MaxiProcessor:phase: ${phase}`);
          this.port.postMessage({ phase: phase, c: "phase" });
        }

        this.bitclock = Maximilian.maxiBits.sig(Math.floor(this.clockPhase(1,0) * 1023.999999999));

        let w=0;
        //new code waiting?
        let barTrig = this.clockTrig(this.barFrequency,0);
        if (this.codeSwapState == this.codeSwapStates.QUEUD) {
          //fade in when a new bar happens
          if (barTrig) {
            this.codeSwapState = this.codeSwapStates.XFADING;
            this.currentSignalFunction = 1 - this.currentSignalFunction;
            console.log("xfade start", this.currentSignalFunction);
          }
        }
        if (this.codeSwapState == this.codeSwapStates.XFADING) {
          let sig0 = this.signals[0](this._q[0], inputs[0][0][i], this._mems[0]);
          let sig1 = this.signals[1](this._q[1], inputs[0][0][i], this._mems[1]);
          // let xf = this.xfadeControl.play(i == 0 ? 1 : 0);
          let xf = this.xfadeControl.play(barTrig);
          // if (i==0) console.log(xf);
          w = Maximilian.maxiXFade.xfade(sig0, sig1, xf);
          if (this.xfadeControl.isLineComplete()) {
            this.codeSwapState = this.codeSwapStates.NONE;
            console.log("xfade complete", xf);
          }
        }else {
          //no xfading - play as normal
          w = this.signals[this.currentSignalFunction](this._q[this.currentSignalFunction], inputs[0][0][i], this._mems[this.currentSignalFunction]);
        }

        // let scope = this._mems[this.currentSignalFunction][":show"];
				// let scopeValue = scope !== undefined ? scope : output[channel][0];        
        // output[1][i] = specgramValue;

        //mono->stereo
        for (let channel = 0; channel < channelCount; channel++) {
          output[channel][i] = w;
        }

      }

      //remove old algo and data?
      let oldIdx = 1.0 - this.currentSignalFunction;
      if (this.xfadeControl.isLineComplete() && this._cleanup[oldIdx] == 0) {
        this.signals[oldIdx] = this.silence;
        //clean up object heap - we must do this because emscripten objects need manual memory management
        for(let obj in this._q[oldIdx]) {
          //if there a delete() function
          if (this._q[oldIdx][obj].delete != undefined) {
            //delete the emscripten object manually
            this._q[oldIdx][obj].delete();
          }
        }
        //create a blank new heap for the next livecode evaluation
        this._q[oldIdx] = this.newq();
        //signal that the cleanup is complete
        this._cleanup[oldIdx] = 1;

      }

    }
    return true;
  }

  translateFloat32ArrayToBuffer(audioFloat32ArrayBuffer) {

    var maxiSampleBufferData = new Maximilian.VectorDouble();
    for (var i = 0; i < audioFloat32ArrayBuffer.length; i++) {
      maxiSampleBufferData.push_back(audioFloat32ArrayBuffer[i]);
    }
    return maxiSampleBufferData;
  }

};

registerProcessor("maxi-processor", MaxiProcessor);
