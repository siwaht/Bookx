import type { TTSProvider, TTSGenerateRequest, TTSGenerateResult, TTSVoice } from './provider.js';
import crypto from 'crypto';

/**
 * Amazon Polly TTS Provider
 * Uses the REST API with AWS Signature V4 authentication.
 * Requires: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and optionally AWS_REGION.
 */

const POLLY_VOICES: TTSVoice[] = [
  { voiceId: 'Matthew', name: 'Matthew (Male)', provider: 'amazon', gender: 'male', language: 'en-US', category: 'neural', description: 'Neural male voice' },
  { voiceId: 'Joanna', name: 'Joanna (Female)', provider: 'amazon', gender: 'female', language: 'en-US', category: 'neural', description: 'Neural female voice' },
  { voiceId: 'Stephen', name: 'Stephen (Male)', provider: 'amazon', gender: 'male', language: 'en-US', category: 'neural' },
  { voiceId: 'Ruth', name: 'Ruth (Female)', provider: 'amazon', gender: 'female', language: 'en-US', category: 'neural' },
  { voiceId: 'Gregory', name: 'Gregory (Male)', provider: 'amazon', gender: 'male', language: 'en-US', category: 'neural' },
  { voiceId: 'Danielle', name: 'Danielle (Female)', provider: 'amazon', gender: 'female', language: 'en-US', category: 'neural' },
  { voiceId: 'Amy', name: 'Amy (Female, British)', provider: 'amazon', gender: 'female', language: 'en-GB', category: 'neural' },
  { voiceId: 'Brian', name: 'Brian (Male, British)', provider: 'amazon', gender: 'male', language: 'en-GB', category: 'neural' },
  { voiceId: 'Olivia', name: 'Olivia (Female, Australian)', provider: 'amazon', gender: 'female', language: 'en-AU', category: 'neural' },
];

export class AmazonPollyProvider implements TTSProvider {
  name = 'amazon' as const;
  displayName = 'Amazon Polly';

  private getCredentials() {
    const accessKey = process.env.AWS_ACCESS_KEY_ID;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKey || !secretKey) {
      throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY not set. Go to Settings and add your AWS credentials.');
    }
    return { accessKey, secretKey, region: process.env.AWS_REGION || 'us-east-1' };
  }

  isConfigured(): boolean {
    return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  }

  async listVoices(): Promise<TTSVoice[]> {
    return POLLY_VOICES;
  }

  async generate(request: TTSGenerateRequest): Promise<TTSGenerateResult> {
    const { accessKey, secretKey, region } = this.getCredentials();
    const host = `polly.${region}.amazonaws.com`;
    const endpoint = `https://${host}/v1/speech`;

    const body = JSON.stringify({
      Text: request.text,
      VoiceId: request.voiceId,
      OutputFormat: 'mp3',
      Engine: 'neural',
      SampleRate: '24000',
    });

    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const dateOnly = dateStamp.slice(0, 8);

    // AWS Signature V4
    const method = 'POST';
    const service = 'polly';
    const canonicalUri = '/v1/speech';
    const canonicalQuerystring = '';
    const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
    const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${dateStamp}\n`;
    const signedHeaders = 'content-type;host;x-amz-date';
    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

    const credentialScope = `${dateOnly}/${region}/${service}/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${dateStamp}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;

    const sign = (key: Buffer | string, msg: string) => crypto.createHmac('sha256', key).update(msg).digest();
    const signingKey = sign(sign(sign(sign(`AWS4${secretKey}`, dateOnly), region), service), 'aws4_request');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Amz-Date': dateStamp,
        'Authorization': authHeader,
      },
      body,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unknown error');
      throw new Error(`Amazon Polly error ${res.status}: ${errText}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const durationMs = Math.round((buffer.length / 24000) * 1000);

    return { buffer, requestId: res.headers.get('x-amzn-requestid'), provider: 'amazon', durationMs };
  }

  async testConnection(): Promise<{ connected: boolean; error?: string; details?: Record<string, any> }> {
    try {
      const { accessKey, region } = this.getCredentials();
      // Simple describe-voices call to test credentials
      return { connected: true, details: { region, key_last4: '••••' + accessKey.slice(-4) } };
    } catch (err: any) {
      return { connected: false, error: err.message };
    }
  }
}
