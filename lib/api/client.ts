import axios from 'axios'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || ''

export const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// When NEXT_PUBLIC_API_URL is not set, all calls will use mock data
// and this client won't be invoked by the UI components.
export const isMockMode = !BASE_URL
