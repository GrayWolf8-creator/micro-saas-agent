const axios = require('axios');

class GW8SignalClient {
  constructor(baseUrl) {
    // Defaults to your production Render endpoint
    this.baseUrl = baseUrl || 'https://your-render-service.onrender.com';
  }

  /**
   * Fetches the latest signal from the x402 endpoint.
   * Pass the Base mainnet transaction hash / payment proof header once paid.
   */
  async getSignal(paymentProof = null) {
    try {
      const headers = {};
      if (paymentProof) {
        headers['X-402-Payment'] = paymentProof;
      }

      const response = await axios.post(`${this.baseUrl}/api/agent`, {}, { headers });
      return response.data;
    } catch (error) {
      if (error.response && error.response.status === 402) {
        return {
          status: 402,
          message: 'Payment Required',
          details: error.response.data
        };
      }
      throw error;
    }
  }

  /**
   * Fetches the free preview endpoint to check market state before paying.
   */
  async getPreview() {
    const response = await axios.get(`${this.baseUrl}/api/preview`);
    return response.data;
  }
}

module.exports = GW8SignalClient;