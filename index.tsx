/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, LiveServerMessage, Modality, Session } from '@google/genai';
import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { createBlob, decode, decodeAudioData } from './utils';
import './visual-3d';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';

  private client!: GoogleGenAI;
  private session!: Session;

  // FIX: hỗ trợ cả AudioContext và webkitAudioContext
  private inputAudioContext = new ((window as any).AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
  private outputAudioContext = new ((window as any).AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();

  private nextStartTime = 0;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private scriptProcessorNode: ScriptProcessorNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: white;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;
    }

    button {
      outline: none;
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: white;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.1);
      width: 64px;
      height: 64px;
      cursor: pointer;
      font-size: 24px;
      padding: 0;
      margin: 0;
    }

    button:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    button[disabled] {
      opacity: 0.4;
      cursor: not-allowed;
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: import.meta.env.VITE_API_KEY || '',
    });

    this.outputNode.connect(this.outputAudioContext.destination);
    await this.initSession();
  }

  private async initSession() {
    const model = 'gemini-2.5-flash-preview-native-audio-dialog';

    try {
      this.session = await this.client.live.connect({
        model,
        callbacks: {
          onopen: () => this.updateStatus('🔗 Connected'),
          onmessage: async (message: LiveServerMessage) => {
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData;

            if (audio) {
              this.nextStartTime = Math.max(this.nextStartTime, this.outputAudioContext.currentTime);
              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000,
                1,
              );

              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () => this.sources.delete(source));

              source.start(this.nextStartTime);
              this.nextStartTime += audioBuffer.duration;
              this.sources.add(source);
            }

            if (message.serverContent?.interrupted) {
              for (const s of this.sources.values()) {
                s.stop();
                this.sources.delete(s);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => this.updateError(e.message),
          onclose: (e: CloseEvent) => this.updateStatus(`❌ Closed: ${e.reason}`),
        },
        config: {
          systemInstruction: `
Bạn là **Cô Emma**, một giáo viên tiếng Anh ảo thân thiện và chuyên nghiệp, dạy học cho người Việt Nam ở mọi trình độ.
Mục tiêu của bạn là giúp người học hiểu ngữ pháp, từ vựng, phát âm, và phản xạ giao tiếp tiếng Anh một cách tự nhiên.
Bạn nói chuyện bằng tiếng Việt lẫn tiếng Anh, tùy theo trình độ của học viên.
Luôn giải thích rõ ràng, dễ hiểu, và sử dụng ví dụ thực tế.
Giọng điệu ấm áp, khích lệ, và lịch sự – giống như một người thầy tận tâm giúp học trò tiến bộ.
          `,
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
        },
      });
    } catch (e) {
      console.error(e);
      this.updateError('Không thể kết nối với Google GenAI API.');
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
  }

  private updateError(msg: string) {
    this.error = msg;
    console.error(msg);
  }

  private async startRecording() {
    if (this.isRecording) return;

    await this.inputAudioContext.resume();
    this.updateStatus('🎙️ Đang xin quyền truy cập micro...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.sourceNode = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 256;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(bufferSize, 1, 1);

      this.scriptProcessorNode.onaudioprocess = (event) => {
        if (!this.isRecording) return;
        const inputBuffer = event.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);
        this.session?.sendRealtimeInput({ media: createBlob(pcmData) });
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.updateStatus('🔴 Đang ghi âm...');
    } catch (err: any) {
      this.updateError(`Không thể ghi âm: ${err.message}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording) return;

    this.isRecording = false;
    this.updateStatus('⏹️ Dừng ghi âm');

    if (this.scriptProcessorNode) this.scriptProcessorNode.disconnect();
    if (this.sourceNode) this.sourceNode.disconnect();

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
  }

  private reset() {
    this.session?.close();
    this.initSession();
    this.updateStatus('🔁 Phiên mới được tạo.');
  }

  render() {
    return html`
      <div>
        <div class="controls">
          <button @click=${this.reset} ?disabled=${this.isRecording}>🔁</button>
          <button @click=${this.startRecording} ?disabled=${this.isRecording}>🎙️</button>
          <button @click=${this.stopRecording} ?disabled=${!this.isRecording}>⏹️</button>
        </div>

        <div id="status">${this.error || this.status}</div>

        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}>
        </gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}
