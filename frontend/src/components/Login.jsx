import React from 'react'
export default function Login() {
  return (
    <div className="max-w-sm mx-auto mt-10 rounded-lg border border-gray-200 dark:border-gray-700
                    bg-white dark:bg-gray-800 p-6">
      <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Login</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
        Internal use – no authentication required.
      </p>
      <button className="mt-4 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded transition-colors">
        Enter
      </button>
    </div>
  )
}
