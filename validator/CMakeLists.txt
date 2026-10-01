cmake_minimum_required(VERSION 3.16)
project(btcpp_validate CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(behaviortree_cpp REQUIRED)

add_executable(btcpp_validate main.cpp)
# A build from source, as in the Docker image, exports BT::behaviortree_cpp; the
# ROS package, as in CI, exports behaviortree_cpp::behaviortree_cpp.
if(TARGET BT::behaviortree_cpp)
  target_link_libraries(btcpp_validate BT::behaviortree_cpp)
else()
  target_link_libraries(btcpp_validate behaviortree_cpp::behaviortree_cpp)
endif()
