defmodule SupersessionQueue.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      {Registry, keys: :unique, name: SupersessionQueue.Registry},
      {DynamicSupervisor, name: SupersessionQueue.KeySupervisor, strategy: :one_for_one}
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: SupersessionQueue.Supervisor)
  end
end
