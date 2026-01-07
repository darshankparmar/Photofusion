import { NextRequest } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fileToPart(file: File) {
    return file.arrayBuffer().then((buf) => ({
        inlineData: {
            data: Buffer.from(buf).toString('base64'),
            mimeType: file.type || 'image/png',
        },
    }));
}

export async function POST(req: NextRequest) {
    try {
        const form = await req.formData();
        const base = form.get('baseImage');
        const product = form.get('productImage');
        const promptRaw = String(form.get('prompt') || '').trim();

        if (!(base instanceof File) || !(product instanceof File)) {
            return new Response(JSON.stringify({ error: 'Both baseImage and productImage are required.' }), { status: 400 });
        }
        // Prompt is optional; supply a generic default when not provided
        const defaultPrompt = 'Replace the product in the base image with the product from the second image, matching perspective, lighting, shadows, and scale. Keep everything else unchanged.';
        const prompt = promptRaw || defaultPrompt;

        const apiKey = process.env.GOOGLE_API_KEY;
        if (!apiKey) {
            return new Response(JSON.stringify({ error: 'Server misconfigured: missing GOOGLE_API_KEY.' }), { status: 500 });
        }

        // Basic prompt policy: hard limit to 300 chars to keep requests concise
        if (prompt.length > 300) {
            return new Response(JSON.stringify({ error: 'Prompt too long (max 300 chars).' }), { status: 400 });
        }

        const [basePart, productPart] = await Promise.all([fileToPart(base), fileToPart(product)]);

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-image' });
        const systemHint = 'Create a new image by combining the provided images. Maintain photorealism, perspective, and lighting. Output only the final composed image.';

        const response = await model.generateContent([
            basePart,
            productPart,
            `${systemHint}\nUser instruction: ${prompt}`,
        ]);

        const candidate = (response as any)?.response?.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        const imagePart = parts.find((p: any) => p.inlineData && p.inlineData.data);
        if (!imagePart) {
            const text = parts.map((p: any) => p.text).filter(Boolean).join('\n');
            return new Response(JSON.stringify({ error: 'Model did not return an image.', modelText: text || 'No content.' }), { status: 502 });
        }
        const { data, mimeType } = imagePart.inlineData;
        const buf = Buffer.from(data, 'base64');
        return new Response(buf, { headers: { 'Content-Type': mimeType || 'image/png' } });
    } catch (err: any) {
        const status = err?.status || err?.response?.status;
        if (status === 429) {
            let retryAfterSec = 10;
            try {
                const details = err?.errorDetails || [];
                const retryInfo = details.find((d: any) => d['@type']?.includes('RetryInfo'));
                if (retryInfo?.retryDelay) {
                    const match = String(retryInfo.retryDelay).match(/([0-9]+)s/);
                    if (match) retryAfterSec = parseInt(match[1], 10);
                }
            } catch { }
            return new Response(JSON.stringify({ error: 'Rate limited by Gemini API. Please wait and try again.', retryAfterSec }), { status: 429 });
        }
        return new Response(JSON.stringify({ error: 'Failed to generate image.', details: err?.message || String(err) }), { status: 500 });
    }
}
