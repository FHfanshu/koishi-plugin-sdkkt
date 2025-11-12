import { SDMetadata, ComfyUIWorkflow, ComfyUINode } from './types'

/**
 * ComfyUI metadata parser
 * Handles ComfyUI workflow and prompt JSON formats
 */

/**
 * Extract ComfyUI metadata from workflow or prompt
 */
export function extractComfyUIMetadata(
  workflow: any,
  prompt: any,
  metadata?: SDMetadata
): SDMetadata {
  const result: SDMetadata = metadata || {}

  const data = workflow || prompt
  if (!data) return result

  // Handle different ComfyUI export formats
  if (data.nodes && Array.isArray(data.nodes)) {
    parseComfyUINodeFormat(data as ComfyUIWorkflow, result)
  } else if (data.prompt && typeof data.prompt === 'object') {
    parseComfyUIPromptFormat(data.prompt, result)
  } else if (typeof data === 'object') {
    // Direct prompt object
    parseComfyUIPromptFormat(data, result)
  }

  return result
}

/**
 * Parse node-based workflow format
 */
function parseComfyUINodeFormat(workflow: ComfyUIWorkflow, metadata: SDMetadata): void {
  if (!workflow.nodes || !Array.isArray(workflow.nodes)) return

  let promptNode: ComfyUINode | null = null
  let negativeNode: ComfyUINode | null = null
  let samplerNode: ComfyUINode | null = null
  let ksamplerNode: ComfyUINode | null = null

  // Find relevant nodes
  for (const node of workflow.nodes) {
    switch (node.type) {
      case 'CLIPTextEncode':
        if (!promptNode) {
          promptNode = node
        } else if (!negativeNode) {
          negativeNode = node
        }
        break

      case 'KSampler':
      case 'KSamplerAdvanced':
        ksamplerNode = node
        break

      case 'SamplerCustom':
        samplerNode = node
        break
    }
  }

  // Extract prompts
  if (promptNode?.widgets_values?.[0]) {
    metadata.prompt = String(promptNode.widgets_values[0])
  }

  if (negativeNode?.widgets_values?.[0]) {
    metadata.negativePrompt = String(negativeNode.widgets_values[0])
  }

  // Extract sampler parameters
  if (ksamplerNode?.widgets_values) {
    const values = ksamplerNode.widgets_values

    // KSampler typical order: seed, steps, cfg, sampler_name, scheduler, denoise
    if (values[0] !== undefined) metadata.seed = String(values[0])
    if (values[1] !== undefined) metadata.steps = String(values[1])
    if (values[2] !== undefined) metadata.cfgScale = String(values[2])
    if (values[3] !== undefined) metadata.sampler = `${values[3]}`
  }

  // Extract from SamplerCustom
  if (samplerNode?.widgets_values) {
    const values = samplerNode.widgets_values

    if (values[0] !== undefined) metadata.sampler = String(values[0])
    if (values[1] !== undefined) metadata.cfgScale = String(values[1])
  }

  // Look for additional metadata in other nodes
  extractComfyUIAdditionalData(workflow.nodes, metadata)
}

/**
 * Parse prompt format (node mapping)
 */
function parseComfyUIPromptFormat(prompt: any, metadata: SDMetadata): void {
  if (!prompt || typeof prompt !== 'object') return

  // Find positive and negative CLIPTextEncode nodes
  for (const [nodeId, node] of Object.entries<any>(prompt)) {
    if (!node || typeof node !== 'object') continue

    if (node.class_type === 'CLIPTextEncode' || node.class_type === 'CLIPTextEncoder') {
      const inputs = node.inputs || node.input
      if (!inputs) continue

      const text = inputs.text || inputs.string || inputs.prompt
      if (text) {
        if (!metadata.prompt) {
          metadata.prompt = text
        } else if (!metadata.negativePrompt) {
          metadata.negativePrompt = text
        }
      }
    }

    // Extract from KSampler
    if (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') {
      const inputs = node.inputs || node.input
      if (!inputs) continue

      if (inputs.seed !== undefined) metadata.seed = String(inputs.seed)
      if (inputs.steps !== undefined) metadata.steps = String(inputs.steps)
      if (inputs.cfg !== undefined || inputs.cfg_scale !== undefined) {
        metadata.cfgScale = String(inputs.cfg || inputs.cfg_scale)
      }
      if (inputs.sampler_name || inputs.sampler) {
        metadata.sampler = String(inputs.sampler_name || inputs.sampler)
      }
      if (inputs.denoise !== undefined) {
        metadata.parameters = `${metadata.parameters || ''}\nDenoising: ${inputs.denoise}`.trim()
      }
    }

    // Extract from SamplerCustom
    if (node.class_type === 'SamplerCustom') {
      const inputs = node.inputs || node.input
      if (!inputs) continue

      if (inputs.cfg !== undefined) metadata.cfgScale = String(inputs.cfg)
      if (inputs.guider) {
        if (typeof inputs.guider === 'string') {
          metadata.sampler = inputs.guider
        } else if (inputs.guider.sampler_name) {
          metadata.sampler = inputs.guider.sampler_name
        }
      }
    }
  }
}

/**
 * Extract additional data from nodes
 */
function extractComfyUIAdditionalData(nodes: ComfyUINode[], metadata: SDMetadata): void {
  if (!nodes || !Array.isArray(nodes)) return

  for (const node of nodes) {
    // Check for model info
    if (node.type === 'CheckpointLoader' || node.type === 'CheckpointLoaderSimple') {
      if (node.widgets_values?.[0]) {
        metadata.model = String(node.widgets_values[0])
        metadata.parameters = `${metadata.parameters || ''}\nModel: ${node.widgets_values[0]}`.trim()
      }
    }

    // Check for image dimensions
    if (node.type === 'EmptyLatentImage') {
      if (node.widgets_values?.[1] && node.widgets_values?.[2]) {
        const width = node.widgets_values[1]
        const height = node.widgets_values[2]
        metadata.size = `${width}x${height}`
      }
    }

    // Check for VAE
    if (node.type === 'VAELoader') {
      if (node.widgets_values?.[0]) {
        metadata.parameters = `${metadata.parameters || ''}\nVAE: ${node.widgets_values[0]}`.trim()
      }
    }

    // Check for LoRAs
    if (node.type === 'LoraLoader') {
      if (node.widgets_values?.[0]) {
        const loraName = node.widgets_values[0]
        const strength = node.widgets_values[1] || node.widgets_values[2]
        metadata.parameters = `${metadata.parameters || ''}\nLoRA: ${loraName} (str: ${strength})`.trim()
      }
    }
  }
}

/**
 * Check if data looks like ComfyUI format
 */
export function isComfyUIFormat(data: any): boolean {
  if (!data || typeof data !== 'object') return false

  // Check for node format
  if (data.nodes && Array.isArray(data.nodes)) {
    for (const node of data.nodes) {
      if (node.type && typeof node.type === 'string') {
        if (['CLIPTextEncode', 'KSampler', 'KSamplerAdvanced', 'EmptyLatentImage'].includes(node.type)) {
          return true
        }
      }
    }
  }

  // Check for prompt format
  if (data.prompt && typeof data.prompt === 'object') {
    for (const node of Object.values<any>(data.prompt)) {
      if (node && node.class_type && typeof node.class_type === 'string') {
        if (node.class_type.includes('KSampler') || node.class_type.includes('CLIPTextEncode')) {
          return true
        }
      }
    }
  }

  // Check for direct prompt object
  for (const node of Object.values<any>(data)) {
    if (node && node.class_type && typeof node.class_type === 'string') {
      if (node.class_type.includes('KSampler') || node.class_type.includes('CLIPTextEncode')) {
        return true
      }
    }
  }

  return false
}

/**
 * Serialize metadata to ComfyUI prompt format
 */
export function serializeComfyUIMetadata(metadata: SDMetadata): any {
  const prompt: any = {}

  // Basic KSampler setup
  const ksamplerId = '3'
  const positiveId = '6'
  const negativeId = '7'
  const modelId = '4'
  const latentId = '5'

  // Model loader
  prompt[modelId] = {
    inputs: {
      ckpt_name: metadata.model || 'model.safetensors'
    },
    class_type: 'CheckpointLoaderSimple'
  }

  // Positive prompt
  prompt[positiveId] = {
    inputs: {
      text: metadata.prompt || '',
      clip: [modelId, 1]
    },
    class_type: 'CLIPTextEncode'
  }

  // Negative prompt
  prompt[negativeId] = {
    inputs: {
      text: metadata.negativePrompt || '',
      clip: [modelId, 1]
    },
    class_type: 'CLIPTextEncode'
  }

  // Empty latent image
  const dimensions = metadata.size ? String(metadata.size).split('x') : ['512', '512']
  prompt[latentId] = {
    inputs: {
      width: parseInt(dimensions[0], 10) || 512,
      height: parseInt(dimensions[1], 10) || 512,
      batch_size: 1
    },
    class_type: 'EmptyLatentImage'
  }

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
  }

  return { prompt }
}

export default {
  extractComfyUIMetadata,
  isComfyUIFormat,
  serializeComfyUIMetadata
}
