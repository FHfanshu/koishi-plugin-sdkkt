/**
 * ComfyUI metadata parser
 * Handles ComfyUI workflow and prompt JSON formats
 */

import { SDMetadata } from './a1111';

interface ComfyUINode {
    id?: number;
    type?: string;
    title?: string;
    widgets_values?: unknown[];
    inputs?: Array<{ name: string; link?: number }>;
}

interface ComfyUIPromptNode {
    class_type?: string;
    inputs?: Record<string, unknown>;
    input?: Record<string, unknown>;
}

interface ComfyUIWorkflow {
    nodes?: ComfyUINode[];
    links?: unknown[][];
}

/**
 * Extract ComfyUI metadata from workflow or prompt
 */
export function extractComfyUIMetadata(workflow: ComfyUIWorkflow | null, prompt: Record<string, ComfyUIPromptNode> | null, metadata: SDMetadata): SDMetadata {
    const result = metadata || {};
    const data = workflow || prompt;
    if (!data) return result;

    // Handle different ComfyUI export formats
    if (data.nodes && Array.isArray(data.nodes)) {
        parseComfyUINodeFormat(data as ComfyUIWorkflow, result);
    } else if ((data as Record<string, unknown>).prompt && typeof (data as Record<string, unknown>).prompt === 'object') {
        parseComfyUIPromptFormat((data as Record<string, unknown>).prompt as Record<string, ComfyUIPromptNode>, result);
    } else if (typeof data === 'object') {
        // Direct prompt object
        parseComfyUIPromptFormat(data as Record<string, ComfyUIPromptNode>, result);
    }

    return result;
}

/**
 * Parse node-based workflow format
 * Output all node information (modified to show full workflow)
 */
function parseComfyUINodeFormat(workflow: ComfyUIWorkflow, metadata: SDMetadata): void {
    if (!workflow.nodes || !Array.isArray(workflow.nodes)) return;

    // Collect all nodes that have widgets_values
    const allContent: string[] = [];

    for (const node of workflow.nodes) {
        if (node.widgets_values && Array.isArray(node.widgets_values) && node.widgets_values.length > 0) {
            let nodeInfo = `节点: ${node.type || 'Unknown'}`;
            if (node.title) nodeInfo += ` (${node.title})`; // Some nodes have title property

            const widgetsContent: string[] = [];
            node.widgets_values.forEach((value, index) => {
                if (value !== undefined && value !== null && value !== '') {
                    const strValue = String(value).trim();
                    if (strValue) {
                        widgetsContent.push(`${index}: ${strValue}`);
                    }
                }
            });

            if (widgetsContent.length > 0) {
                allContent.push(`${nodeInfo}\n${widgetsContent.join('\n')}`);
            }
        }
    }

    // Set parameters field with all content
    if (allContent.length > 0) {
        metadata.parameters = allContent.join('\n\n');
    }

    // Build node ID map for link tracing
    const nodeById = new Map<number, ComfyUINode>();
    for (const node of workflow.nodes) {
        if (node.id !== undefined) {
            nodeById.set(node.id, node);
        }
    }

    // Build link map: linkId -> [sourceNodeId, sourceSlot, targetNodeId, targetSlot]
    // Links format: [linkId, sourceNodeId, sourceSlot, targetNodeId, targetSlot, type]
    const linkMap = new Map<number, unknown[]>();
    if (workflow.links && Array.isArray(workflow.links)) {
        for (const link of workflow.links) {
            if (Array.isArray(link) && link.length >= 5) {
                linkMap.set(link[0] as number, link);
            }
        }
    }

    // Find KSampler node and trace positive/negative connections
    let ksamplerNode: ComfyUINode | null = null;
    let samplerNode: ComfyUINode | null = null;
    let positiveNodeId: number | null = null;
    let negativeNodeId: number | null = null;

    for (const node of workflow.nodes) {
        if (node.type === 'KSampler' || node.type === 'KSamplerAdvanced') {
            ksamplerNode = node;

            // Find positive and negative input links
            // KSampler inputs order: model, positive, negative, latent_image (may vary by version)
            if (node.inputs && Array.isArray(node.inputs)) {
                for (const input of node.inputs) {
                    if (input.name === 'positive' && input.link !== undefined) {
                        const link = linkMap.get(input.link);
                        if (link) positiveNodeId = link[1] as number; // source node id
                    } else if (input.name === 'negative' && input.link !== undefined) {
                        const link = linkMap.get(input.link);
                        if (link) negativeNodeId = link[1] as number;
                    }
                }
            }
            break;
        } else if (node.type === 'SamplerCustom') {
            samplerNode = node;
        }
    }

    // Get prompt nodes by traced connections
    const promptNode = positiveNodeId !== null ? nodeById.get(positiveNodeId) : null;
    const negativeNode = negativeNodeId !== null ? nodeById.get(negativeNodeId) : null;

    // Fallback: if no connections traced, use first two CLIPTextEncode nodes
    let fallbackPromptNode: ComfyUINode | null = null;
    let fallbackNegativeNode: ComfyUINode | null = null;

    if (!promptNode || !negativeNode) {
        const clipTextNodes: ComfyUINode[] = [];
        for (const node of workflow.nodes) {
            if (node.type === 'CLIPTextEncode') {
                clipTextNodes.push(node);
            }
        }

        if (clipTextNodes.length > 0 && !promptNode) {
            fallbackPromptNode = clipTextNodes[0];
        }
        if (clipTextNodes.length > 1 && !negativeNode) {
            fallbackNegativeNode = clipTextNodes[1];
        }
    }

    // Extract prompts
    const finalPromptNode = promptNode || fallbackPromptNode;
    const finalNegativeNode = negativeNode || fallbackNegativeNode;

    if (finalPromptNode?.widgets_values?.[0]) {
        metadata.prompt = String(finalPromptNode.widgets_values[0]);
    }
    if (finalNegativeNode?.widgets_values?.[0]) {
        metadata.negativePrompt = String(finalNegativeNode.widgets_values[0]);
    }

    // Extract KSampler parameters
    if (ksamplerNode?.widgets_values) {
        const values = ksamplerNode.widgets_values;
        if (values[0] !== undefined) metadata.seed = String(values[0]);
        if (values[1] !== undefined) metadata.steps = String(values[1]);
        if (values[2] !== undefined) metadata.cfgScale = String(values[2]);
        if (values[3] !== undefined) metadata.sampler = `${values[3]}`;
    }

    if (samplerNode?.widgets_values) {
        const values = samplerNode.widgets_values;
        if (values[0] !== undefined) metadata.sampler = String(values[0]);
        if (values[1] !== undefined) metadata.cfgScale = String(values[1]);
    }

    // Extract additional metadata
    extractComfyUIAdditionalData(workflow.nodes, metadata);
}

/**
 * Parse prompt format (node mapping)
 */
function parseComfyUIPromptFormat(prompt: Record<string, ComfyUIPromptNode>, metadata: SDMetadata): void {
    if (!prompt || typeof prompt !== 'object') return;

    // Find positive and negative CLIPTextEncode nodes
    for (const [, node] of Object.entries(prompt)) {
        if (!node || typeof node !== 'object') continue;

        if (node.class_type === 'CLIPTextEncode' || node.class_type === 'CLIPTextEncoder') {
            const inputs = node.inputs || node.input;
            if (!inputs) continue;

            const text = inputs.text || inputs.string || inputs.prompt;
            if (text) {
                if (!metadata.prompt) {
                    metadata.prompt = text as string;
                } else if (!metadata.negativePrompt) {
                    metadata.negativePrompt = text as string;
                }
            }
        }

        // Extract from KSampler
        if (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') {
            const inputs = node.inputs || node.input;
            if (!inputs) continue;

            if (inputs.seed !== undefined) metadata.seed = String(inputs.seed);
            if (inputs.steps !== undefined) metadata.steps = String(inputs.steps);
            if (inputs.cfg !== undefined || inputs.cfg_scale !== undefined) {
                metadata.cfgScale = String(inputs.cfg || inputs.cfg_scale);
            }
            if (inputs.sampler_name || inputs.sampler) {
                metadata.sampler = String(inputs.sampler_name || inputs.sampler);
            }
            if (inputs.denoise !== undefined) {
                metadata.parameters = `${metadata.parameters || ''}\nDenoising: ${inputs.denoise}`.trim();
            }
        }

        // Extract from SamplerCustom
        if (node.class_type === 'SamplerCustom') {
            const inputs = node.inputs || node.input;
            if (!inputs) continue;

            if (inputs.cfg !== undefined) metadata.cfgScale = String(inputs.cfg);
            if (inputs.guider) {
                if (typeof inputs.guider === 'string') {
                    metadata.sampler = inputs.guider;
                } else if (typeof inputs.guider === 'object' && (inputs.guider as Record<string, unknown>).sampler_name) {
                    metadata.sampler = (inputs.guider as Record<string, unknown>).sampler_name as string;
                }
            }
        }
    }
}

/**
 * Extract additional data from nodes
 */
function extractComfyUIAdditionalData(nodes: ComfyUINode[], metadata: SDMetadata): void {
    if (!nodes || !Array.isArray(nodes)) return;

    for (const node of nodes) {
        // Check for model info
        if (node.type === 'CheckpointLoader' || node.type === 'CheckpointLoaderSimple') {
            if (node.widgets_values?.[0]) {
                metadata.model = String(node.widgets_values[0]);
                metadata.parameters = `${metadata.parameters || ''}\nModel: ${node.widgets_values[0]}`.trim();
            }
        }

        // Check for image dimensions
        if (node.type === 'EmptyLatentImage') {
            if (node.widgets_values?.[1] && node.widgets_values?.[2]) {
                const width = node.widgets_values[1];
                const height = node.widgets_values[2];
                metadata.size = `${width}x${height}`;
            }
        }

        // Check for VAE
        if (node.type === 'VAELoader') {
            if (node.widgets_values?.[0]) {
                metadata.parameters = `${metadata.parameters || ''}\nVAE: ${node.widgets_values[0]}`.trim();
            }
        }

        // Check for LoRAs
        if (node.type === 'LoraLoader') {
            if (node.widgets_values?.[0]) {
                const loraName = node.widgets_values[0];
                const strength = node.widgets_values[1] || node.widgets_values[2];
                metadata.parameters = `${metadata.parameters || ''}\nLoRA: ${loraName} (str: ${strength})`.trim();
            }
        }
    }
}

/**
 * Check if data looks like ComfyUI format
 */
export function isComfyUIFormat(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;

    const dataObj = data as Record<string, unknown>;

    // Check for node format
    if (dataObj.nodes && Array.isArray(dataObj.nodes)) {
        for (const node of dataObj.nodes as ComfyUINode[]) {
            if (node.type && typeof node.type === 'string') {
                if (['CLIPTextEncode', 'KSampler', 'KSamplerAdvanced', 'EmptyLatentImage'].includes(node.type)) {
                    return true;
                }
            }
        }
    }

    // Check for prompt format
    if (dataObj.prompt && typeof dataObj.prompt === 'object') {
        for (const node of Object.values(dataObj.prompt as Record<string, ComfyUIPromptNode>)) {
            if (node && node.class_type && typeof node.class_type === 'string') {
                if (node.class_type.includes('KSampler') || node.class_type.includes('CLIPTextEncode')) {
                    return true;
                }
            }
        }
    }

    // Check for direct prompt object
    for (const node of Object.values(dataObj)) {
        if (node && typeof node === 'object') {
            const promptNode = node as ComfyUIPromptNode;
            if (promptNode.class_type && typeof promptNode.class_type === 'string') {
                if (promptNode.class_type.includes('KSampler') || promptNode.class_type.includes('CLIPTextEncode')) {
                    return true;
                }
            }
        }
    }

    return false;
}

/**
 * Serialize metadata to ComfyUI prompt format
 */
export function serializeComfyUIMetadata(metadata: SDMetadata): { prompt: Record<string, unknown> } {
    const prompt: Record<string, unknown> = {};

    // Basic KSampler setup
    const ksamplerId = '3';
    const positiveId = '6';
    const negativeId = '7';
    const modelId = '4';
    const latentId = '5';

    // Model loader
    prompt[modelId] = {
        inputs: {
            ckpt_name: metadata.model || 'model.safetensors'
        },
        class_type: 'CheckpointLoaderSimple'
    };

    // Positive prompt
    prompt[positiveId] = {
        inputs: {
            text: metadata.prompt || '',
            clip: [modelId, 1]
        },
        class_type: 'CLIPTextEncode'
    };

    // Negative prompt
    prompt[negativeId] = {
        inputs: {
            text: metadata.negativePrompt || '',
            clip: [modelId, 1]
        },
        class_type: 'CLIPTextEncode'
    };

    // Empty latent image
    const dimensions = metadata.size ? String(metadata.size).split('x') : ['512', '512'];
    prompt[latentId] = {
        inputs: {
            width: parseInt(dimensions[0], 10) || 512,
            height: parseInt(dimensions[1], 10) || 512,
            batch_size: 1
        },
        class_type: 'EmptyLatentImage'
    };

    // KSampler
    prompt[ksamplerId] = {
        inputs: {
            seed: metadata.seed ? parseInt(metadata.seed, 10) : Math.floor(Math.random() * 1000000),
            steps: metadata.steps ? parseInt(metadata.steps, 10) : 20,
            cfg: metadata.cfgScale ? parseFloat(metadata.cfgScale) : 7,
            sampler_name: metadata.sampler || 'euler',
            scheduler: 'normal',
            denoise: 1,
            model: [modelId, 0],
            positive: [positiveId, 0],
            negative: [negativeId, 0],
            latent_image: [latentId, 0]
        },
        class_type: 'KSampler'
    };

    return { prompt };
}

export default {
    extractComfyUIMetadata,
    isComfyUIFormat,
    serializeComfyUIMetadata
};