defmodule SupersessionQueue.MixProject do
  use Mix.Project

  def project do
    [
      app: :supersession_queue,
      version: "0.1.0",
      elixir: "~> 1.15",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {SupersessionQueue.Application, []}
    ]
  end

  defp deps do
    [
      {:stream_data, "~> 1.1", only: [:test, :dev]}
    ]
  end
end
