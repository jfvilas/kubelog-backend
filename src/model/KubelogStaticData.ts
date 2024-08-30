/*
Copyright 2024 Julio Fernandez

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
class KubelogStaticData {
    public static clusterKubelogData:Map<string,KubelogClusterData>= new Map();
}

type KubelogNamespacePermissions = {
    namespace:string;
    identityRefs:string[];
}

/*
    SAMPLE Values

    {
        home: 'http://localhost/kwirth',
        apiKey: 'dce1611c-b3d8-6d90-3507-64046112044e|permanent|cluster::::',
        title: 'Kubernetes local',
        namespacePermissions: [ { namespace: 'pre', identityRefs: [Array] } ],
        viewPermissions: [
            { namespace: 'test', allow: [Map], restrict: [Map] },
            { namespace: 'pre', allow: [Map], restrict: [Map] },
            { namespace: 'staging', allow: [Map], restrict: [Map] },
            { namespace: 'corporate', allow: [Map], restrict: [Map] },
            { namespace: 'pro', allow: [Map], deny: [Map] }
        ],
        restartPermissions: [
            { namespace: 'dev', allow: [Map], restrict: [Map], deny: [Map] },
            { namespace: 'pre', allow: [Map], deny: [Map] }
        ]
    }    
*/
export type KubelogPodPermissions = {
    namespace:string;
    allow?:Map<string,string[]|undefined>;
    restrict?:Map<string,string[]|undefined>;
    deny?:Map<string,string[]|undefined>;
}

export type KubelogClusterData = {
    home: string;
    apiKey: string;
    title: string;
    namespacePermissions: KubelogNamespacePermissions[];
    viewPermissions: KubelogPodPermissions[];
    restartPermissions: KubelogPodPermissions[];
}

export { KubelogStaticData }